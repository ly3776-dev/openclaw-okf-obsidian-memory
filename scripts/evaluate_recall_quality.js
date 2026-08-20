#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { daily, ingest, recall } from "../src/core.js";

const DEFAULT_EMBEDDING = {
  baseUrl: "http://127.0.0.1:8008/v1",
  apiKey: "okf-local",
  model: "BAAI/bge-m3"
};

const args = parseArgs(process.argv.slice(2));
const fixturePath = args.fixture || path.resolve("scripts/fixtures/recall_quality_cases.json");
const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));

applyEmbeddingDefaults(args);

const vault = await mkdtemp(path.join(os.tmpdir(), "okf-recall-quality-"));
try {
  const noteById = new Map();
  for (const item of fixtures.notes || []) {
    const result = await ingest({
      vault,
      text: item.text,
      title: item.title,
      sourceType: "text"
    });
    noteById.set(item.id, {
      id: item.id,
      title: result.title,
      path: path.relative(vault, result.filePath).replaceAll("\\", "/")
    });
  }

  const synthesis = await daily({ vault });
  const cases = [];
  for (const item of fixtures.cases || []) {
    const expected = noteById.get(item.expectedId);
    if (!expected) throw new Error(`Unknown expectedId: ${item.expectedId}`);
    const result = await recall({ vault, query: item.query, limit: args.limit || 5 });
    const evaluation = evaluateCase(item, expected, result);
    cases.push(evaluation);
  }

  const failures = cases.filter((item) => !item.ok);
  if (!synthesis.ontology?.validation?.ok) {
    failures.push({
      name: "ontology_validation",
      ok: false,
      reason: "daily ontology graph failed validation",
      issues: synthesis.ontology?.validation?.issues || []
    });
  }
  if (!synthesis.actionQueue?.validation?.ok) {
    failures.push({
      name: "action_queue_validation",
      ok: false,
      reason: "daily ontology action queue failed validation",
      issues: synthesis.actionQueue?.validation?.issues || []
    });
  }
  const vectorProvider = await readVectorProvider(vault);
  if (!args.allowLocal && vectorProvider !== "openai-compatible-embedding") {
    failures.push({
      name: "embedding_provider",
      ok: false,
      reason: `expected openai-compatible-embedding, got ${vectorProvider}`
    });
  }

  const summary = {
    ok: failures.length === 0,
    fixture: path.relative(process.cwd(), fixturePath).replaceAll("\\", "/"),
    vault,
    vectorProvider,
    ontology: synthesis.ontology,
    totalCases: cases.length,
    top1Hits: cases.filter((item) => item.fusedRank === 1).length,
    top3Hits: cases.filter((item) => item.fusedRank > 0 && item.fusedRank <= 3).length,
    vectorTop3Hits: cases.filter((item) => item.vectorRank > 0 && item.vectorRank <= 3).length,
    cases,
    failures
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
} finally {
  if (!args.keepVault) {
    await rm(vault, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  if (parsed.limit) parsed.limit = Number.parseInt(String(parsed.limit), 10);
  return parsed;
}

function applyEmbeddingDefaults(parsed) {
  if (parsed.allowLocal) return;
  process.env.OKF_EMBEDDING_BASE_URL = process.env.OKF_EMBEDDING_BASE_URL || DEFAULT_EMBEDDING.baseUrl;
  process.env.OKF_EMBEDDING_API_KEY = process.env.OKF_EMBEDDING_API_KEY || DEFAULT_EMBEDDING.apiKey;
  process.env.OKF_EMBEDDING_MODEL = process.env.OKF_EMBEDDING_MODEL || DEFAULT_EMBEDDING.model;
}

function evaluateCase(item, expected, result) {
  const fusedRank = rankOfPath(result.fusedMatches, expected.path);
  const vectorRank = rankOfPath(result.vectorMatches, expected.path);
  const ontologyRank = rankOfPath(result.ontologyMatches, expected.path);
  const lexicalRank = rankOfPath(result.matches, expected.path);
  const fusedTop = (result.fusedMatches || []).slice(0, 3).map(compactMatch);
  const vectorTop = (result.vectorMatches || []).slice(0, 3).map(compactMatch);
  return {
    name: item.name,
    ok: fusedRank > 0 && fusedRank <= 3 && vectorRank > 0 && vectorRank <= 3,
    query: item.query,
    expectedId: item.expectedId,
    expectedPath: expected.path,
    fusedRank,
    vectorRank,
    ontologyRank,
    lexicalRank,
    fusedTop,
    vectorTop
  };
}

function rankOfPath(matches, expectedPath) {
  const normalized = normalizePath(expectedPath);
  const index = (matches || []).findIndex((item) => normalizePath(item.path) === normalized);
  return index < 0 ? 0 : index + 1;
}

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function compactMatch(item) {
  return {
    title: item.title,
    path: item.path,
    score: item.score,
    signals: item.signals
  };
}

async function readVectorProvider(vault) {
  try {
    const raw = await readFile(path.join(vault, ".okf-cache", "vector-index.json"), "utf8");
    return JSON.parse(raw).provider || "";
  } catch {
    return "";
  }
}
