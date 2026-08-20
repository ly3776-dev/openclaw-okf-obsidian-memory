import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildOntologyGraph, rankOntologyRecall, validateOntologyGraph } from "../src/ontology.js";

const DEFAULT_COUNTS = [500, 1_000, 10_000];
const OUTPUT_PATH = path.resolve("artifacts", "validation", "m1-ontology-benchmark.json");
const RECALL_RUNS = 40;

const counts = process.argv
  .filter((value) => value.startsWith("--counts="))
  .flatMap((value) => value.slice("--counts=".length).split(","))
  .map((value) => Number.parseInt(value, 10))
  .filter((value) => Number.isFinite(value) && value > 0);

const results = [];
for (const count of counts.length ? counts : DEFAULT_COUNTS) {
  const notes = syntheticNotes(count);
  const buildStarted = performance.now();
  const graph = buildOntologyGraph(notes);
  const buildMs = performance.now() - buildStarted;
  const validation = validateOntologyGraph(graph);
  const semanticLinks = graph.links.filter((item) => item.type === "similar_to" || item.type === "same_domain");
  const degrees = new Map();
  for (const item of semanticLinks) {
    degrees.set(item.from, (degrees.get(item.from) || 0) + 1);
    degrees.set(item.to, (degrees.get(item.to) || 0) + 1);
  }

  rankOntologyRecall(graph, "OpenClaw ontology durable memory", 10);
  const recallSamples = [];
  for (let run = 0; run < RECALL_RUNS; run += 1) {
    const recallStarted = performance.now();
    const matches = rankOntologyRecall(graph, `OpenClaw ontology group ${run % 25}`, 10);
    recallSamples.push(performance.now() - recallStarted);
    if (matches.length === 0) throw new Error(`ontology recall returned no matches for ${count} notes`);
  }

  const result = {
    notes: count,
    buildMs: round(buildMs),
    recallP95Ms: round(percentile(recallSamples, 0.95)),
    objects: graph.objects.length,
    links: graph.links.length,
    semanticLinks: semanticLinks.length,
    maxSemanticDegree: Math.max(0, ...degrees.values()),
    candidatePairs: graph.limits.candidatePairs,
    maxCandidatesBound: count * graph.limits.maxCandidatesPerConcept,
    maxRelationshipBound: count * graph.limits.topK / 2,
    adjacencyConcepts: Object.keys(graph.adjacency.byConcept).length,
    degraded: graph.limits.degraded,
    valid: validation.ok
  };
  assertMilestone(result, graph.limits);
  results.push(result);
}

const report = {
  milestone: "M1",
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  thresholds: {
    build1000Ms: 5_000,
    recallP95Ms: 300,
    topK: 20
  },
  results,
  ok: true
};

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...report, outputPath: OUTPUT_PATH }, null, 2));

function syntheticNotes(count) {
  return Array.from({ length: count }, (_, index) => ({
    title: `OpenClaw ontology benchmark concept ${index}`,
    description: `Obsidian Palantir ontology durable memory group ${index % 25} with shared retrieval evidence.`,
    tags: ["openclaw", "obsidian", "ontology", `group-${index % 25}`],
    type: "Concept",
    timestamp: "2026-07-19T00:00:00.000Z",
    resource: `synthetic-input-${index}`,
    confidence: 0.82,
    source_type: "text",
    path: `concepts/benchmark-${index}.md`,
    body: "Shared keyword entity relation content for bounded candidate selection and recall performance."
  }));
}

function assertMilestone(result, limits) {
  if (!result.valid) throw new Error(`${result.notes}: ontology validation failed`);
  if (result.maxSemanticDegree > limits.topK) throw new Error(`${result.notes}: Top-K degree exceeded`);
  if (result.semanticLinks > result.maxRelationshipBound) throw new Error(`${result.notes}: relationship bound exceeded`);
  if (result.candidatePairs > result.maxCandidatesBound) throw new Error(`${result.notes}: candidate bound exceeded`);
  if (result.adjacencyConcepts !== result.notes) throw new Error(`${result.notes}: adjacency is incomplete`);
  if (result.notes === 1_000 && result.buildMs >= 5_000) throw new Error(`1000-note build took ${result.buildMs}ms`);
  if (result.recallP95Ms >= 300) throw new Error(`${result.notes}: recall P95 took ${result.recallP95Ms}ms`);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}
