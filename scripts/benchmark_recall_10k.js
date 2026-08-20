import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ingest, recall, sqliteIndexRebuild } from "../src/core.js";

const countArg = process.argv.find((value) => value.startsWith("--count="));
const noteCount = countArg ? Number.parseInt(countArg.slice(8), 10) : 10_000;
const recallRuns = 20;
const vault = await mkdtemp(path.join(os.tmpdir(), "okf-recall-benchmark-"));
const outputPath = path.resolve("artifacts", "validation", "m4-recall-10k-benchmark.json");

try {
  const conceptsDir = path.join(vault, "concepts");
  await mkdir(conceptsDir, { recursive: true });
  const fixtureStarted = performance.now();
  for (let offset = 0; offset < noteCount; offset += 128) {
    await Promise.all(Array.from({ length: Math.min(128, noteCount - offset) }, (_, relative) => {
      const index = offset + relative;
      return writeFile(path.join(conceptsDir, `benchmark-${index}.md`), renderNote(index), "utf8");
    }));
  }
  const fixtureMs = performance.now() - fixtureStarted;

  const warmStarted = performance.now();
  await recall({ vault, query: "benchmarkgroup42", limit: 10 });
  const warmMs = performance.now() - warmStarted;
  const sqlite = await sqliteIndexRebuild({ vault });
  if (!sqlite.ok) throw new Error(`SQLite setup failed: ${sqlite.reason}`);

  const samples = [];
  for (let run = 0; run < recallRuns; run += 1) {
    const started = performance.now();
    const result = await recall({ vault, query: `benchmarkgroup${run % 100}`, limit: 10 });
    samples.push(performance.now() - started);
    if (!result.fusedMatches.length || !result.vectorMatches.length || !result.ontologyMatches.length) {
      throw new Error(`hybrid recall signal missing on run ${run}`);
    }
  }

  const ingestStarted = performance.now();
  const ingested = await ingest({
    vault,
    title: "Incremental benchmark note",
    sourceType: "text",
    text: "Incremental benchmark note verifies one changed Markdown note updates SQLite and vector caches without an LLM call. Unique token incrementalbenchmarkfresh."
  });
  const ingestMs = performance.now() - ingestStarted;
  const vectorMetadata = JSON.parse(await readFile(path.join(vault, ".okf-cache", "vector-index.json"), "utf8"));
  const indexMetadata = JSON.parse(await readFile(path.join(vault, ".okf-cache", "index.json"), "utf8"));
  const hotP95Ms = percentile(samples, 0.95);
  const report = {
    milestone: "M4",
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    notes: noteCount,
    fixtureMs: round(fixtureMs),
    coldWarmupMs: round(warmMs),
    hotRecall: {
      runs: recallRuns,
      p50Ms: round(percentile(samples, 0.5)),
      p95Ms: round(hotP95Ms),
      maxMs: round(Math.max(...samples))
    },
    incrementalIngest: {
      durationMs: round(ingestMs),
      indexCount: ingested.indexCount,
      indexMode: indexMetadata.update?.mode,
      changed: indexMetadata.update?.changed?.length || 0,
      vectorReused: vectorMetadata.stats?.reused,
      vectorEmbedded: vectorMetadata.stats?.embedded,
      vectorStorage: vectorMetadata.storage,
      sqliteIncremental: Boolean(ingested.sqlite.ok)
    },
    thresholds: { hotRecallP95Ms: 1_000, incrementalIngestMs: 3_000 },
    ok: hotP95Ms < 1_000
      && ingestMs < 3_000
      && indexMetadata.update?.mode === "incremental"
      && vectorMetadata.stats?.embedded <= 3
      && vectorMetadata.storage === "float32-le"
  };
  if (!report.ok) throw new Error(`M4 benchmark failed: ${JSON.stringify(report)}`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, outputPath }, null, 2));
} finally {
  await rm(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function renderNote(index) {
  const group = index % 100;
  return `---
type: Concept
title: Benchmark concept ${index}
description: Durable OpenClaw Obsidian benchmark memory in group ${group}.
tags: [openclaw, obsidian, ontology, benchmarkgroup${group}]
timestamp: 2026-07-19T00:00:00.000Z
source_type: text
confidence: 0.82
---

Synthetic benchmark body ${index}. Shared hybrid recall content with unique token note${index} and group token benchmarkgroup${group}.
`;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}
