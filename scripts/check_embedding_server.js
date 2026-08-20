#!/usr/bin/env node

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.OKF_EMBEDDING_BASE_URL || "http://127.0.0.1:8008/v1",
    apiKey: process.env.OKF_EMBEDDING_API_KEY || "okf-local",
    model: process.env.OKF_EMBEDDING_MODEL || "BAAI/bge-m3",
    text: "抖音亚马逊运营广告复盘和ACOS浪费词"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const models = await request(args, "models");
  const embedding = await request(args, "embeddings", {
    model: args.model,
    input: args.text
  });
  const vector = embedding.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length < 128) {
    throw new Error(`Embedding vector is missing or too small: ${vector?.length || 0}`);
  }
  const hasModel = (models.data || []).some((item) => item.id === args.model);
  console.log(JSON.stringify({
    ok: true,
    baseUrl: normalizeBase(args.baseUrl),
    model: args.model,
    modelListed: hasModel,
    dimensions: vector.length
  }, null, 2));
}

async function request(args, pathValue, body) {
  const response = await fetch(openAiUrl(args.baseUrl, pathValue), {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${args.apiKey}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`${pathValue} failed with HTTP ${response.status}: ${raw.slice(0, 500)}`);
  }
  return JSON.parse(raw);
}

function openAiUrl(baseUrl, pathValue) {
  return `${normalizeBase(baseUrl)}/${String(pathValue).replace(/^\/+/, "")}`;
}

function normalizeBase(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
