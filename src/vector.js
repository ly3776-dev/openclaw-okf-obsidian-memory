import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { atomicWriteFile, atomicWriteJson } from "./fsSafe.js";

const VECTOR_VERSION = "0.2";
const LOCAL_DIMENSIONS = 384;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
let openClawHostProvider = null;

export function registerOpenClawEmbeddingProvider(provider) {
  if (!provider || typeof provider.embedBatch !== "function" || typeof provider.embedQuery !== "function") {
    throw new Error("OpenClaw embedding provider requires embedBatch and embedQuery functions.");
  }
  openClawHostProvider = provider;
  return () => {
    if (openClawHostProvider === provider) openClawHostProvider = null;
  };
}

export async function buildVectorIndex({ vault, config, notes, sourceGeneration = "" }) {
  const work = buildWork(notes || []);
  const failures = [];
  for (const provider of embeddingProviders(config)) {
    try {
      return await buildWithProvider({ vault, config, work, sourceGeneration, provider, failures });
    } catch (error) {
      failures.push(`${provider.providerName}: ${error.message}`);
    }
  }
  throw new Error(`No embedding provider could build the vector index: ${failures.join(" | ")}`);
}

export async function loadOrBuildVectorIndex({ vault, config, notes, sourceGeneration = "" }) {
  const providers = embeddingProviders(config);
  try {
    const index = await readVectorIndex(vault, config);
    const provider = providers.find((item) => providerIdentityHash(item) === index.providerIdentityHash);
    if (index.sourceGeneration === sourceGeneration && provider) return index;
  } catch {
    // Rebuild or incrementally update below.
  }
  return buildVectorIndex({ vault, config, notes, sourceGeneration });
}

export async function writeVectorIndex(vault, config, index) {
  const cacheDir = path.join(vault, config.cacheDir);
  await mkdir(cacheDir, { recursive: true });
  const dimensions = index.dimensions || LOCAL_DIMENSIONS;
  const vectorFile = `vector-index-${generationToken(index)}.f32`;
  const vectorPath = path.join(cacheDir, vectorFile);
  const buffer = Buffer.allocUnsafe(index.entries.length * dimensions * 4);
  const metadataEntries = [];
  let vectorOffset = 0;
  for (const entry of index.entries) {
    if (entry.vector.length !== dimensions) throw new Error(`Vector dimension mismatch for ${entry.id}`);
    for (let coordinate = 0; coordinate < dimensions; coordinate += 1) {
      buffer.writeFloatLE(Number(entry.vector[coordinate]) || 0, (vectorOffset + coordinate) * 4);
    }
    metadataEntries.push({
      id: entry.id,
      notePath: entry.notePath,
      title: entry.title,
      kind: entry.kind,
      text: entry.text,
      contentHash: entry.contentHash,
      vectorOffset,
      vectorLength: dimensions
    });
    vectorOffset += dimensions;
  }
  await atomicWriteFile(vectorPath, buffer);
  await atomicWriteJson(path.join(cacheDir, "vector-index.json"), {
    ...index,
    vectorFile,
    storage: "float32-le",
    entries: metadataEntries
  });
}

export async function rankVectorRecall(index, query, limit = 5, config = {}) {
  const provider = embeddingProviders(config)
    .find((item) => providerIdentityHash(item) === index.providerIdentityHash);
  let queryVector;
  try {
    queryVector = provider
      ? await embedQueryWithProvider(provider, query)
      : embedTextLocal(query);
  } catch {
    queryVector = embedTextLocal(query);
  }
  const adjusted = adjustDimensions(queryVector, index.dimensions || LOCAL_DIMENSIONS);
  const byNote = new Map();
  for (const entry of index.entries || []) {
    const score = cosine(adjusted, entry.vector);
    if (score <= 0) continue;
    const existing = byNote.get(entry.notePath);
    if (!existing || score > existing.score) {
      byNote.set(entry.notePath, {
        title: entry.title,
        path: entry.notePath,
        score: Number(score.toFixed(4)),
        bestChunk: entry.kind,
        preview: entry.text.slice(0, 260)
      });
    }
  }
  return [...byNote.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

async function buildWithProvider({ vault, config, work, sourceGeneration, provider, failures }) {
  const identityHash = providerIdentityHash(provider);
  let previous = null;
  try {
    const loaded = await readVectorIndex(vault, config);
    if (loaded.providerIdentityHash === identityHash) previous = loaded;
  } catch {
    // No reusable index.
  }
  const previousByKey = new Map((previous?.entries || []).map((entry) => [`${entry.id}|${entry.contentHash}`, entry]));
  const entries = new Array(work.length);
  const missing = [];
  for (let index = 0; index < work.length; index += 1) {
    const item = work[index];
    const reused = previousByKey.get(`${item.id}|${item.contentHash}`);
    if (reused) entries[index] = { ...item, vector: reused.vector };
    else missing.push({ index, item });
  }

  if (missing.length) {
    const vectors = await embedBatchWithProvider(provider, missing.map((item) => item.item.text), provider.documentInputType);
    for (let index = 0; index < missing.length; index += 1) {
      entries[missing[index].index] = { ...missing[index].item, vector: vectors[index] };
    }
  }
  let dimensions = entries[0]?.vector?.length || provider.dimensions || LOCAL_DIMENSIONS;
  if (entries.some((entry) => entry.vector.length !== dimensions)) {
    const vectors = await embedBatchWithProvider(provider, work.map((item) => item.text), provider.documentInputType);
    dimensions = vectors[0]?.length || dimensions;
    if (vectors.some((vector) => vector.length !== dimensions)) throw new Error("Embedding provider returned inconsistent dimensions");
    for (let index = 0; index < work.length; index += 1) entries[index] = { ...work[index], vector: vectors[index] };
  }

  const index = {
    vector_version: VECTOR_VERSION,
    generatedAt: new Date().toISOString(),
    sourceGeneration,
    dimensions,
    provider: provider.providerName,
    providerKind: provider.kind,
    model: provider.model,
    providerIdentityHash: identityHash,
    fallbackReason: failures.join(" | "),
    stats: {
      entries: entries.length,
      reused: entries.length - missing.length,
      embedded: missing.length,
      batchSize: provider.batchSize
    },
    entries
  };
  await writeVectorIndex(vault, config, index);
  return index;
}

async function readVectorIndex(vault, config) {
  const cacheDir = path.join(vault, config.cacheDir);
  const metadata = JSON.parse(await readFile(path.join(cacheDir, "vector-index.json"), "utf8"));
  if (metadata.vector_version !== VECTOR_VERSION || metadata.storage !== "float32-le" || !metadata.vectorFile) {
    throw new Error("legacy vector index requires rebuild");
  }
  const binary = await readFile(path.join(cacheDir, metadata.vectorFile));
  const entries = metadata.entries.map((entry) => {
    const vector = new Float32Array(entry.vectorLength);
    for (let coordinate = 0; coordinate < entry.vectorLength; coordinate += 1) {
      vector[coordinate] = binary.readFloatLE((entry.vectorOffset + coordinate) * 4);
    }
    return { ...entry, vector };
  });
  return { ...metadata, entries };
}

function buildWork(notes) {
  const work = [];
  for (const note of notes) {
    for (const chunk of chunkNote(note)) {
      const id = `${note.path}#${chunk.kind}`;
      work.push({
        id,
        notePath: note.path,
        title: note.title,
        kind: chunk.kind,
        text: chunk.text,
        contentHash: crypto.createHash("sha256").update(chunk.text).digest("hex")
      });
    }
  }
  return work;
}

function embeddingProviders(config = {}) {
  const providers = [];
  if (openClawHostProvider) {
    providers.push({
      kind: "openclaw-native",
      providerName: `openclaw-native:${openClawHostProvider.id || "host"}`,
      model: openClawHostProvider.model || "host-default",
      batchSize: embeddingBatchSize(),
      timeoutMs: embeddingTimeoutMs(),
      retries: embeddingRetries(),
      embedBatch: openClawHostProvider.embedBatch.bind(openClawHostProvider),
      embedQuery: openClawHostProvider.embedQuery.bind(openClawHostProvider)
    });
  }
  const openClawRemote = remoteProviderFromValues({
    kind: "openclaw-native",
    providerName: "openclaw-native-embedding",
    baseUrl: process.env.OPENCLAW_EMBEDDING_BASE_URL,
    apiKey: process.env.OPENCLAW_EMBEDDING_API_KEY,
    model: process.env.OPENCLAW_EMBEDDING_MODEL
  }, config);
  if (openClawRemote) providers.push(openClawRemote);

  const embedding = config.embedding || {};
  const llm = config.llm || {};
  const configured = remoteProviderFromValues({
    kind: "openai-compatible",
    providerName: "openai-compatible-embedding",
    baseUrl: process.env.OKF_EMBEDDING_BASE_URL || embedding.baseUrl || process.env.OKF_LLM_BASE_URL || llm.baseUrl || process.env.OPENAI_BASE_URL,
    apiKey: process.env.OKF_EMBEDDING_API_KEY || embedding.apiKey || process.env.OKF_LLM_API_KEY || llm.apiKey || process.env.OPENAI_API_KEY,
    model: process.env.OKF_EMBEDDING_MODEL || embedding.model || process.env.OPENAI_EMBEDDING_MODEL,
    inputType: process.env.OKF_EMBEDDING_INPUT_TYPE || embedding.inputType || "",
    queryInputType: process.env.OKF_EMBEDDING_QUERY_INPUT_TYPE || embedding.queryInputType,
    documentInputType: process.env.OKF_EMBEDDING_DOCUMENT_INPUT_TYPE || embedding.documentInputType
  }, config);
  if (configured && !providers.some((item) => providerIdentityHash(item) === providerIdentityHash(configured))) providers.push(configured);
  providers.push(localProvider());
  return providers;
}

function remoteProviderFromValues(values) {
  if (!values.baseUrl || !values.apiKey || !values.model) return null;
  const inputType = values.inputType || "";
  return {
    ...values,
    queryInputType: values.queryInputType || inputType,
    documentInputType: values.documentInputType || inputType,
    batchSize: embeddingBatchSize(),
    timeoutMs: embeddingTimeoutMs(),
    retries: embeddingRetries()
  };
}

function localProvider() {
  return {
    kind: "local",
    providerName: "local-hashed-token-embedding",
    model: "fnv1a-384-v1",
    dimensions: LOCAL_DIMENSIONS,
    batchSize: embeddingBatchSize(),
    timeoutMs: embeddingTimeoutMs(),
    retries: 1
  };
}

async function embedBatchWithProvider(provider, texts, inputType = "") {
  if (!texts.length) return [];
  if (provider.kind === "local") return texts.map(embedTextLocal);
  if (provider.embedBatch) {
    return batched(texts, provider.batchSize, async (batch) => withRetry(
      () => withTimeout((signal) => provider.embedBatch(batch, { signal }), provider.timeoutMs, "OpenClaw embedding batch"),
      provider.retries
    ));
  }
  return batched(texts, provider.batchSize, (batch) => withRetry(
    () => fetchEmbeddingBatch(provider, batch, inputType),
    provider.retries
  ));
}

async function embedQueryWithProvider(provider, text) {
  if (provider.kind === "local") return embedTextLocal(text);
  if (provider.embedQuery) {
    return normalize(await withRetry(
      () => withTimeout((signal) => provider.embedQuery(text, { signal }), provider.timeoutMs, "OpenClaw embedding query"),
      provider.retries
    ));
  }
  return (await embedBatchWithProvider(provider, [text], provider.queryInputType))[0];
}

async function fetchEmbeddingBatch(provider, texts, inputType) {
  return withTimeout(async (signal) => {
    const body = { model: provider.model, input: texts };
    if (inputType) body.input_type = inputType;
    const response = await fetch(openAiUrl(provider.baseUrl, "embeddings"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal
    });
    const raw = await response.text();
    if (!response.ok) {
      const error = new Error(`Embedding request failed with HTTP ${response.status}: ${raw.slice(0, 500)}`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    const data = JSON.parse(raw);
    const vectors = (data.data || []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item) => item.embedding);
    if (vectors.length !== texts.length) throw new Error(`Embedding response count mismatch: expected ${texts.length}, got ${vectors.length}`);
    return vectors.map(normalize);
  }, provider.timeoutMs, "embedding request");
}

async function batched(values, size, operation) {
  const output = [];
  for (let offset = 0; offset < values.length; offset += size) {
    const result = await operation(values.slice(offset, offset + size));
    output.push(...result.map(normalize));
  }
  return output;
}

async function withRetry(operation, attempts) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || error.retryable === false) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 150 * (2 ** (attempt - 1)))));
    }
  }
  throw lastError;
}

async function withTimeout(operation, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = "EMBEDDING_TIMEOUT";
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function providerIdentityHash(provider) {
  return crypto.createHash("sha256").update(JSON.stringify({
    kind: provider.kind,
    provider: provider.providerName,
    model: provider.model,
    baseUrl: provider.baseUrl || "",
    dimensions: provider.dimensions || null,
    queryInputType: provider.queryInputType || "",
    documentInputType: provider.documentInputType || ""
  })).digest("hex");
}

function generationToken(index) {
  const generation = index.sourceGeneration || crypto.createHash("sha256").update(index.entries.map((entry) => entry.contentHash).join("|")).digest("hex");
  return `${generation.slice(0, 16)}-${index.providerIdentityHash.slice(0, 8)}`;
}

function adjustDimensions(vector, dimensions) {
  if (vector.length === dimensions) return vector;
  if (vector.length > dimensions) return normalize(vector.slice(0, dimensions));
  const adjusted = new Float32Array(dimensions);
  adjusted.set(vector);
  return normalize(adjusted);
}

function chunkNote(note) {
  const chunks = [{ kind: "summary", text: `${note.title || ""}\n${note.description || ""}\n${(note.tags || []).join(" ")}` }];
  const body = String(note.body || "").replace(/\s+/g, " ").trim();
  if (body) {
    const size = 900;
    for (let offset = 0; offset < body.length; offset += size) {
      chunks.push({ kind: `body-${Math.floor(offset / size) + 1}`, text: body.slice(offset, offset + size) });
    }
  }
  return chunks.filter((chunk) => chunk.text.trim());
}

function openAiUrl(baseUrl, pathValue) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedPath = pathValue.replace(/^\/+/, "");
  return /\/v1$/i.test(base) ? `${base}/${normalizedPath}` : `${base}/v1/${normalizedPath}`;
}

function embedTextLocal(text) {
  const vector = new Float32Array(LOCAL_DIMENSIONS);
  for (const token of expandTokens(tokenize(text))) vector[hash(token) % LOCAL_DIMENSIONS] += weight(token);
  return normalize(vector);
}

function expandTokens(tokens) {
  const expanded = [];
  for (const token of tokens) {
    expanded.push(token);
    if (/[\p{Script=Han}]/u.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1; index += 1) expanded.push(token.slice(index, index + 2));
      for (let index = 0; index < token.length - 2; index += 1) expanded.push(token.slice(index, index + 3));
    }
  }
  for (let index = 0; index < tokens.length - 1; index += 1) expanded.push(`${tokens[index]}_${tokens[index + 1]}`);
  return expanded;
}

function tokenize(text) {
  return String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function weight(token) {
  if (token.includes("_")) return 1.4;
  return token.length >= 6 ? 1.2 : 1;
}

function normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += Number(value) * Number(value);
  const norm = Math.sqrt(sum) || 1;
  const output = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) output[index] = Number(vector[index]) / norm;
  return output;
}

function cosine(a, b) {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index];
  return sum;
}

function hash(value) {
  let output = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    output ^= value.charCodeAt(index);
    output = Math.imul(output, 16777619);
  }
  return output >>> 0;
}

function embeddingBatchSize() {
  return boundedInteger(process.env.OKF_EMBEDDING_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 256);
}

function embeddingTimeoutMs() {
  return boundedInteger(process.env.OKF_EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 600_000);
}

function embeddingRetries() {
  return boundedInteger(process.env.OKF_EMBEDDING_RETRIES, DEFAULT_RETRIES, 1, 8);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
