import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { actionQueueExecute, actionQueueList, actionQueueUpdate, daily, ingest, okfExport, okfValidate, ontologyValidate, recall, sqliteIndexRebuild } from "../src/core.js";
import { downloadDouyin, looksLikeDouyin } from "../src/douyin.js";
import { buildActionQueue, validateActionQueue } from "../src/actionQueue.js";
import { buildOntologyGraph, rankOntologyRecall, validateOntologyGraph } from "../src/ontology.js";
import { buildVectorIndex, registerOpenClawEmbeddingProvider } from "../src/vector.js";
import { atomicWriteFile, withFileLock } from "../src/fsSafe.js";

const MOCK_MEDIA_EXTRACTOR = path.resolve("test/fixtures/mock_media_extractor.js");

test("ingest writes an OKF note and index", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  try {
    const result = await ingest({
      vault,
      text: "OpenClaw captures research notes and recalls them later. Obsidian stores the Markdown vault.",
      sourceType: "text"
    });
    assert.equal(result.ok, true);
    assert.ok(result.vector.entries >= 1);
    assert.equal("sqlite" in result, true);
    const note = await readFile(result.filePath, "utf8");
    assert.match(note, /okf_version:\s+['"]0\.1['"]/);
    assert.match(note, /一句话结论 \/ One-Line Takeaway/);
    assert.match(note, /适合什么时候用 \/ When To Use/);
    const index = await readFile(path.join(vault, "index.md"), "utf8");
    assert.match(index, /OKF Vault Index/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("daily creates a synthesis note", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  try {
    await ingest({ vault, text: "OpenClaw and Obsidian work together for durable memory.", sourceType: "text" });
    const result = await daily({ vault });
    assert.equal(result.ok, true);
    assert.ok(result.ontology.objects >= 1);
    assert.ok(result.ontology.links >= 1);
    assert.equal(result.ontology.validation.ok, true);
    assert.equal(result.actionQueue.validation.ok, true);
    assert.ok(result.vector.entries >= 1);
    assert.equal("sqlite" in result, true);
    const synthesis = await readFile(result.filePath, "utf8");
    assert.match(synthesis, /Daily Ontology Synthesis/);
    const graph = JSON.parse(await readFile(path.join(vault, ".okf-cache", "ontology.json"), "utf8"));
    assert.equal(graph.schema.objectTypes.Concept.properties.includes("title"), true);
    const validation = await ontologyValidate({ vault });
    assert.equal(validation.ok, true);
    assert.equal(validation.objects, graph.objects.length);
    const queue = JSON.parse(await readFile(path.join(vault, ".okf-cache", "ontology-actions.json"), "utf8"));
    assert.equal(queue.action_queue_version, "0.1");
    const actionMarkdown = await readFile(path.join(vault, "syntheses", "ontology-actions.md"), "utf8");
    assert.match(actionMarkdown, /Ontology Action Queue/);
    const canvas = JSON.parse(await readFile(path.join(vault, "syntheses", "ontology.canvas"), "utf8"));
    assert.equal(Array.isArray(canvas.nodes), true);
    assert.equal(Array.isArray(canvas.edges), true);
    const base = await readFile(path.join(vault, "syntheses", "ontology-actions.base"), "utf8");
    assert.match(base, /Ontology Actions/);
    assert.equal(result.obsidianViews.actionNotes, queue.actions.length);
    if (queue.actions.length) {
      const actionNote = await readFile(path.join(vault, "syntheses", "ontology-action-notes", `${queue.actions[0].id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100)}.md`), "utf8");
      assert.match(actionNote, /type: OntologyAction/);
    }
    const vector = JSON.parse(await readFile(path.join(vault, ".okf-cache", "vector-index.json"), "utf8"));
    assert.equal(vector.provider, "local-hashed-token-embedding");
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("generated synthesis views do not pollute ontology concepts on repeated daily runs", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  try {
    await ingest({ vault, text: "Repeated daily synthesis should not index generated action queue views as concepts.", sourceType: "text" });
    await ingest({ vault, text: "Generated Obsidian views are maintenance artifacts rather than source knowledge notes.", sourceType: "text" });
    const first = await daily({ vault });
    assert.equal(first.ontology.validation.ok, true);
    const second = await daily({ vault });
    assert.equal(second.ontology.validation.ok, true);
    const graph = JSON.parse(await readFile(path.join(vault, ".okf-cache", "ontology.json"), "utf8"));
    assert.equal(graph.objects.some((object) => object.id === "concept:syntheses-ontology-actions-md"), false);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("action queue preserves accepted work and archives stale proposals", () => {
  const graph = buildOntologyGraph([
    actionFixtureNote("Alpha duplicate concept", "Shared duplicate review content for OpenClaw ontology action testing."),
    actionFixtureNote("Beta duplicate concept", "Shared duplicate review content for OpenClaw ontology action testing.")
  ]);
  const firstQueue = buildActionQueue({ graph, generatedAt: "2026-06-23T00:00:00.000Z" });
  assert.equal(validateActionQueue(firstQueue, graph).ok, true);
  assert.ok(firstQueue.actions.length >= 1);

  const accepted = {
    ...firstQueue,
    actions: firstQueue.actions.map((action, index) => index === 0 ? { ...action, status: "accepted" } : action)
  };
  const secondQueue = buildActionQueue({ graph, previousQueue: accepted, generatedAt: "2026-06-24T00:00:00.000Z" });
  assert.equal(secondQueue.actions.find((action) => action.id === firstQueue.actions[0].id).status, "accepted");

  const emptyGraph = buildOntologyGraph([actionFixtureNote("Gamma standalone", "Unique standalone content.")]);
  const thirdQueue = buildActionQueue({ graph: emptyGraph, previousQueue: firstQueue, generatedAt: "2026-06-25T00:00:00.000Z" });
  assert.equal(thirdQueue.actions.some((action) => action.status === "archived" && action.stale), true);
  assert.equal(validateActionQueue(thirdQueue, emptyGraph).ok, true);
});

test("action queue list and update persist lifecycle history", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  try {
    await ingest({ vault, text: "Duplicate ontology action review for OpenClaw OKF memory consolidation.", sourceType: "text" });
    await ingest({ vault, text: "Duplicate ontology action review for OpenClaw OKF memory consolidation and merge review.", sourceType: "text" });
    await daily({ vault });

    const listed = await actionQueueList({ vault, limit: 5 });
    assert.equal(listed.ok, true);
    assert.ok(listed.actions.length >= 1);

    const updated = await actionQueueUpdate({
      vault,
      id: listed.actions[0].id,
      status: "accepted",
      note: "unit test accepted this ontology action"
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.action.status, "accepted");
    assert.equal(updated.action.history.at(-1).note, "unit test accepted this ontology action");

    const accepted = await actionQueueList({ vault, status: "accepted" });
    assert.equal(accepted.actions.some((action) => action.id === listed.actions[0].id), true);

    await daily({ vault });
    const afterDaily = await actionQueueList({ vault, status: "accepted" });
    const preserved = afterDaily.actions.find((action) => action.id === listed.actions[0].id);
    assert.equal(Boolean(preserved), true);
    assert.equal(preserved.history.at(-1).note, "unit test accepted this ontology action");

    const executed = await actionQueueExecute({ vault, id: listed.actions[0].id });
    assert.equal(executed.ok, true);
    assert.match(executed.artifact.path, /syntheses\/.*\.md|entities\/.*\.md/);
    assert.match(await readFile(executed.artifact.filePath, "utf8"), /Lifecycle|Review|Entity/);
    assert.equal(["in_progress", "done"].includes(executed.action.status), true);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("ontology validator rejects broken references and type mismatches", () => {
  const graph = buildOntologyGraph([
    {
      title: "Ontology validator fixture",
      description: "Checks object, link, and action schema constraints.",
      tags: ["okf"],
      type: "Concept",
      timestamp: "2026-06-23T00:00:00.000Z",
      resource: "inline-input",
      confidence: 0.8,
      source_type: "text",
      path: "concepts/ontology-validator-fixture.md",
      body: "OpenClaw ontology validation should catch broken references."
    }
  ]);
  graph.links.push({
    type: "has_tag",
    from: graph.objects.find((item) => item.type === "Tag").id,
    to: graph.objects.find((item) => item.type === "Concept").id,
    evidence: [],
    confidence: 1.3
  });
  graph.actions.push({
    type: "promote_entity_note",
    targets: [graph.objects.find((item) => item.type === "Concept").id],
    description: "Wrong target type",
    confidence: 0.4
  });
  const validation = validateOntologyGraph(graph);
  assert.equal(validation.ok, false);
  assert.equal(validation.issues.some((issue) => issue.code === "link_from_type_mismatch"), true);
  assert.equal(validation.issues.some((issue) => issue.code === "invalid_link_confidence"), true);
  assert.equal(validation.issues.some((issue) => issue.code === "action_target_type_mismatch"), true);
});

test("ontology candidate generation stays linear and enforces Top-K per concept", () => {
  const noteCount = 500;
  const notes = Array.from({ length: noteCount }, (_, index) => ({
    title: `High overlap ontology concept ${index}`,
    description: "OpenClaw Obsidian Palantir ontology shared durable memory benchmark.",
    tags: ["openclaw", "obsidian", "ontology", `group-${index % 10}`],
    type: "Concept",
    timestamp: "2026-07-19T00:00:00.000Z",
    resource: `inline-${index}`,
    confidence: 0.8,
    source_type: "text",
    path: `concepts/high-overlap-${index}.md`,
    body: "Shared keyword entity relation content for bounded ontology candidate selection."
  }));
  const graph = buildOntologyGraph(notes);
  const semanticLinks = graph.links.filter((item) => item.type === "similar_to" || item.type === "same_domain");
  const degree = new Map();
  for (const item of semanticLinks) {
    degree.set(item.from, (degree.get(item.from) || 0) + 1);
    degree.set(item.to, (degree.get(item.to) || 0) + 1);
  }

  assert.equal(validateOntologyGraph(graph).ok, true);
  assert.equal(graph.limits.topK, 20);
  assert.ok(Math.max(0, ...degree.values()) <= graph.limits.topK);
  assert.ok(semanticLinks.length <= noteCount * graph.limits.topK / 2);
  assert.ok(graph.limits.candidatePairs <= noteCount * graph.limits.maxCandidatesPerConcept);
  assert.ok(graph.links.length <= graph.limits.maxLinks);
  assert.equal(Object.keys(graph.adjacency.byConcept).length, noteCount);

  graph.links.filter = () => {
    throw new Error("recall must use the precomputed adjacency table");
  };
  assert.equal(rankOntologyRecall(graph, "OpenClaw ontology", 5).length, 5);
});

test("ontology relationship and total-link guards degrade explicitly", () => {
  const notes = Array.from({ length: 20 }, (_, index) => actionFixtureNote(
    `Guarded concept ${index}`,
    "Shared duplicate review content for OpenClaw ontology guard testing."
  ));
  const graph = buildOntologyGraph(notes, { maxRelationships: 3, maxLinks: 10 });
  const semanticLinks = graph.links.filter((item) => item.type === "similar_to" || item.type === "same_domain");
  assert.ok(semanticLinks.length <= 3);
  assert.ok(graph.links.length <= 10);
  assert.equal(graph.limits.degraded, true);
  assert.equal(graph.limits.degradedReasons.includes("max_links_reached"), true);
});

test("recall returns matching notes", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  try {
    await ingest({ vault, text: "Vector memory should recall Obsidian OKF notes for OpenClaw agents.", sourceType: "text" });
    const result = await recall({ vault, query: "OpenClaw memory" });
    assert.equal(result.ok, true);
    assert.equal(result.matches.length, 1);
    assert.equal(Array.isArray(result.sqliteMatches), true);
    assert.equal(result.ontologyMatches.length >= 1, true);
    assert.equal(result.vectorMatches.length >= 1, true);
    assert.equal(result.fusedMatches[0].signals.includes("vector"), true);
    assert.match(result.matches[0].title, /Vector memory/i);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("sqlite index can be rebuilt and contributes to fused recall when available", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  try {
    await ingest({
      vault,
      text: "SQLite FTS should accelerate large Obsidian vault recall while vector search still provides semantic matching.",
      sourceType: "text"
    });
    await daily({ vault });
    const indexed = await sqliteIndexRebuild({ vault });
    assert.equal("dbPath" in indexed, true);
    if (!indexed.skipped) {
      assert.equal(indexed.ok, true);
      assert.equal(indexed.notes >= 1, true);
      const header = (await readFile(indexed.dbPath)).subarray(0, 16).toString("utf8");
      assert.match(header, /SQLite format 3/);
    }

    const result = await recall({ vault, query: "SQLite recall acceleration" });
    assert.equal(result.ok, true);
    assert.equal(Array.isArray(result.sqliteMatches), true);
    if (!indexed.skipped) {
      assert.equal(result.sqliteMatches.length >= 1, true);
      assert.equal(result.fusedMatches.some((match) => match.signals.includes("sqlite")), true);
    }
    assert.equal(result.vectorMatches.length >= 1, true);
    assert.equal(result.fusedMatches.some((match) => match.signals.includes("vector")), true);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("remote embedding failure falls back to one local vector provider", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  const previousBase = process.env.OKF_EMBEDDING_BASE_URL;
  const previousKey = process.env.OKF_EMBEDDING_API_KEY;
  const previousModel = process.env.OKF_EMBEDDING_MODEL;
  process.env.OKF_EMBEDDING_BASE_URL = "http://127.0.0.1:9";
  process.env.OKF_EMBEDDING_API_KEY = "test-key";
  process.env.OKF_EMBEDDING_MODEL = "missing-embedding-model";
  try {
    const index = await buildVectorIndex({
      vault,
      config: { cacheDir: ".okf-cache" },
      notes: [
        {
          path: "concepts/a.md",
          title: "Alpha",
          description: "Alpha concept",
          tags: ["alpha"],
          body: "Alpha body text"
        },
        {
          path: "concepts/b.md",
          title: "Beta",
          description: "Beta concept",
          tags: ["beta"],
          body: "Beta body text"
        }
      ]
    });
    assert.equal(index.provider, "local-hashed-token-embedding");
    assert.equal(index.model, "fnv1a-384-v1");
    assert.ok(index.fallbackReason);
    assert.equal(index.entries.every((entry) => entry.vector.length === index.dimensions), true);
  } finally {
    restoreEnv("OKF_EMBEDDING_BASE_URL", previousBase);
    restoreEnv("OKF_EMBEDDING_API_KEY", previousKey);
    restoreEnv("OKF_EMBEDDING_MODEL", previousModel);
    await rm(vault, { recursive: true, force: true });
  }
});

test("vector index batches native embeddings, reuses content hashes, and stores Float32 generations", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vector-incremental-"));
  const previousBase = process.env.OKF_EMBEDDING_BASE_URL;
  const previousKey = process.env.OKF_EMBEDDING_API_KEY;
  const previousModel = process.env.OKF_EMBEDDING_MODEL;
  process.env.OKF_EMBEDDING_BASE_URL = "http://127.0.0.1:9";
  process.env.OKF_EMBEDDING_API_KEY = "unused-bge-key";
  process.env.OKF_EMBEDDING_MODEL = "unused-bge-model";
  const calls = [];
  let dispose = registerOpenClawEmbeddingProvider(mockNativeEmbeddingProvider("native-v1", 4, calls));
  try {
    const notes = Array.from({ length: 70 }, (_, index) => ({
      path: `concepts/vector-${index}.md`,
      title: `Vector concept ${index}`,
      description: `Native embedding batch fixture ${index}`,
      tags: ["vector", `group-${index % 5}`],
      body: ""
    }));
    const first = await buildVectorIndex({ vault, config: { cacheDir: ".okf-cache" }, notes, sourceGeneration: "generation-1" });
    assert.equal(first.provider, "openclaw-native:test-native");
    assert.deepEqual(calls, [64, 6]);
    assert.equal(first.stats.reused, 0);
    assert.equal(first.stats.embedded, 70);

    calls.length = 0;
    const expanded = [...notes, {
      path: "concepts/vector-new.md",
      title: "New vector concept",
      description: "Only this content needs a new embedding",
      tags: ["vector"],
      body: ""
    }];
    const second = await buildVectorIndex({ vault, config: { cacheDir: ".okf-cache" }, notes: expanded, sourceGeneration: "generation-2" });
    assert.deepEqual(calls, [1]);
    assert.equal(second.stats.reused, 70);
    assert.equal(second.stats.embedded, 1);
    const metadataText = await readFile(path.join(vault, ".okf-cache", "vector-index.json"), "utf8");
    const metadata = JSON.parse(metadataText);
    assert.equal(metadata.storage, "float32-le");
    assert.equal(/"vector"\s*:/.test(metadataText), false);
    assert.equal((await stat(path.join(vault, ".okf-cache", metadata.vectorFile))).size, 71 * 4 * 4);

    dispose();
    calls.length = 0;
    dispose = registerOpenClawEmbeddingProvider(mockNativeEmbeddingProvider("native-v2", 6, calls));
    const rebuilt = await buildVectorIndex({ vault, config: { cacheDir: ".okf-cache" }, notes: expanded, sourceGeneration: "generation-3" });
    assert.equal(rebuilt.dimensions, 6);
    assert.equal(rebuilt.stats.reused, 0);
    assert.equal(rebuilt.stats.embedded, 71);
  } finally {
    dispose();
    restoreEnv("OKF_EMBEDDING_BASE_URL", previousBase);
    restoreEnv("OKF_EMBEDDING_API_KEY", previousKey);
    restoreEnv("OKF_EMBEDDING_MODEL", previousModel);
    await rm(vault, { recursive: true, force: true });
  }
});

test("strict OKF validation and export work", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  try {
    await ingest({
      vault,
      text: "Strict OKF export should preserve YAML frontmatter and standard Markdown links.",
      sourceType: "text"
    });
    const validation = await okfValidate({ vault });
    assert.equal(validation.ok, true);
    assert.equal(validation.checked, 1);

    const exported = await okfExport({ vault });
    assert.equal(exported.ok, true);
    assert.equal(exported.exported, 1);
    const index = await readFile(path.join(exported.outputDir, "index.md"), "utf8");
    assert.match(index, /OKF Bundle Index/);
    const exportedValidation = await okfValidate({ vault: exported.outputDir });
    assert.equal(exportedValidation.ok, true);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("ingest can enrich ambiguous text with web context", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  const previous = process.env.OKF_WEB_ENRICH_COMMAND;
  process.env.OKF_WEB_ENRICH_COMMAND = `node ${path.resolve("scripts/mock_web_enrich.js")}`;
  try {
    const result = await ingest({
      vault,
      text: "这个",
      sourceType: "text",
      title: "Ambiguous Capture",
      useWeb: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.enrichment.skipped, false);
    const note = await readFile(result.filePath, "utf8");
    assert.match(note, /Mock research context/);
    assert.match(note, /https:\/\/example\.com\/mock-ontology-source/);
  } finally {
    if (previous === undefined) {
      delete process.env.OKF_WEB_ENRICH_COMMAND;
    } else {
      process.env.OKF_WEB_ENRICH_COMMAND = previous;
    }
    await rm(vault, { recursive: true, force: true });
  }
});

test("daily can include optional LLM ontology review", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  const previous = process.env.OKF_ONTOLOGY_LLM_COMMAND;
  process.env.OKF_ONTOLOGY_LLM_COMMAND = `node ${path.resolve("scripts/mock_ontology_llm.js")}`;
  try {
    await ingest({ vault, text: "Ontology links OpenClaw concepts to Obsidian sources.", sourceType: "text" });
    const result = await daily({ vault, useLlm: true });
    assert.equal(result.ok, true);
    assert.equal(result.llm.skipped, false);
    const synthesis = await readFile(result.filePath, "utf8");
    assert.match(synthesis, /Important Links/);
    assert.match(synthesis, /Promote repeated entities/);
  } finally {
    if (previous === undefined) {
      delete process.env.OKF_ONTOLOGY_LLM_COMMAND;
    } else {
      process.env.OKF_ONTOLOGY_LLM_COMMAND = previous;
    }
    await rm(vault, { recursive: true, force: true });
  }
});

test("ingest auto-extracts json files and writes config", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  const source = path.join(vault, "source.json");
  try {
    await writeFile(source, JSON.stringify({ topic: "OKF", detail: "JSON extraction for Obsidian memory" }), "utf8");
    const result = await ingest({ vault, inputPath: source });
    assert.equal(result.ok, true);
    assert.equal(result.sourceType, "json");
    const config = await readFile(path.join(vault, "okf-obsidian.config.json"), "utf8");
    assert.match(config, /notesDir/);
    const note = await readFile(result.filePath, "utf8");
    assert.match(note, /JSON extraction for Obsidian memory/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("atomic writes preserve the previous cache when interrupted before rename", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "okf-atomic-"));
  const target = path.join(directory, "index.json");
  try {
    await writeFile(target, '{"generation":"old"}\n', "utf8");
    await assert.rejects(
      atomicWriteFile(target, '{"generation":"new"}\n', {
        encoding: "utf8",
        beforeRename: async () => {
          throw new Error("simulated power loss before rename");
        }
      }),
      /simulated power loss/
    );
    assert.equal(await readFile(target, "utf8"), '{"generation":"old"}\n');
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale cross-process locks are recovered", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "okf-stale-lock-"));
  const lockPath = path.join(directory, "write.lock");
  try {
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      token: "abandoned",
      pid: 2147483000,
      hostname: os.hostname(),
      createdAt: "2000-01-01T00:00:00.000Z"
    }), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const result = await withFileLock(lockPath, async () => "recovered", { staleMs: 1, timeoutMs: 1_000 });
    assert.equal(result, "recovered");
    assert.equal((await readdir(directory)).includes("write.lock"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("20 concurrent ingests keep every note and cache generation intact", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-concurrent-"));
  try {
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => ingest({
      vault,
      text: `Concurrent durable memory note ${index} with unique token concurrency${index} for OpenClaw Obsidian.`,
      sourceType: "text",
      title: `Concurrent note ${index}`
    })));
    assert.equal(results.every((result) => result.ok), true);
    const index = JSON.parse(await readFile(path.join(vault, ".okf-cache", "index.json"), "utf8"));
    assert.equal(index.notes.length, 20);
    assert.equal(new Set(index.notes.map((note) => note.path)).size, 20);
    assert.equal(index.notes.every((note) => /^[a-f0-9]{64}$/.test(note.file?.sha256)), true);
    assert.equal(index.notes.every((note) => note.file.size > 0 && note.file.mtimeMs > 0), true);
    assert.equal((await readdir(path.join(vault, ".okf-cache"))).includes("write.lock"), false);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("recursive Vault scan and YAML parser track manual edit move and delete", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-recursive-"));
  const firstDir = path.join(vault, "concepts", "projects", "alpha");
  const firstPath = path.join(firstDir, "manual.md");
  const movedDir = path.join(vault, "concepts", "archive", "2026");
  const movedPath = path.join(movedDir, "manual-moved.md");
  try {
    await mkdir(firstDir, { recursive: true });
    await writeFile(firstPath, `---
type: Concept
title: Manual nested concept
description: |-
  Block YAML description for nested memory.
  Second line remains valid.
tags: [nested, manual]
metadata:
  owner: human
  priority: high
timestamp: 2026-07-19T00:00:00.000Z
source_type: text
confidence: 0.8
---

Original recall token zephyrmanual.
`, "utf8");

    const first = await recall({ vault, query: "zephyrmanual", limit: 5 });
    assert.equal(first.fusedMatches[0].path, "concepts/projects/alpha/manual.md");
    let index = JSON.parse(await readFile(path.join(vault, ".okf-cache", "index.json"), "utf8"));
    assert.deepEqual(index.notes[0].tags, ["nested", "manual"]);
    assert.match(index.notes[0].description, /Second line remains valid/);

    await writeFile(firstPath, `---
type: Concept
title: Manually edited concept
description: Human edit detected through size mtime and SHA-256.
tags: [nested, edited]
timestamp: 2026-07-19T00:01:00.000Z
source_type: text
confidence: 0.9
---

Replacement recall token auroramanual after an Obsidian edit.
`, "utf8");
    const edited = await recall({ vault, query: "auroramanual", limit: 5 });
    assert.equal(edited.fusedMatches[0].title, "Manually edited concept");
    assert.equal((await recall({ vault, query: "zephyrmanual", limit: 5 })).fusedMatches.length, 0);

    await mkdir(movedDir, { recursive: true });
    await rename(firstPath, movedPath);
    const moved = await recall({ vault, query: "auroramanual", limit: 5 });
    assert.equal(moved.fusedMatches[0].path, "concepts/archive/2026/manual-moved.md");

    await rm(movedPath);
    assert.equal((await recall({ vault, query: "auroramanual", limit: 5 })).fusedMatches.length, 0);
    index = JSON.parse(await readFile(path.join(vault, ".okf-cache", "index.json"), "utf8"));
    assert.equal(index.notes.length, 0);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("malformed YAML frontmatter is isolated without aborting Vault indexing", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-malformed-yaml-"));
  try {
    await mkdir(path.join(vault, "concepts"), { recursive: true });
    await writeFile(path.join(vault, "concepts", "broken.md"), `---
type: Concept
title: 'Recoverable legacy note'
description: 'unterminated
tags: [legacy, malformed]
---

# Recoverable body

This note must not prevent other notes from being indexed.
`, "utf8");
    await ingest({ vault, text: "Healthy note remains available beside malformed legacy YAML.", sourceType: "text" });
    const result = await recall({ vault, query: "Healthy note", limit: 5 });
    assert.equal(result.ok, true);
    const index = JSON.parse(await readFile(path.join(vault, ".okf-cache", "index.json"), "utf8"));
    const broken = index.notes.find((note) => note.path === "concepts/broken.md");
    assert.equal(broken.title, "Recoverable legacy note");
    assert.match(broken.frontmatterError, /Missing closing 'quote/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("image inputs route through PaddleOCR", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  const restore = useMockMediaExtractor();
  try {
    const source = path.resolve("examples/sample-image.png");
    const result = await ingest({ vault, inputPath: source });
    assert.equal(result.sourceType, "image");
    const note = await readFile(result.filePath, "utf8");
    assert.match(note, /OpenClaw OKF Obsidian Memory/);
    assert.match(note, /Local source:/);
  } finally {
    restore();
    await rm(vault, { recursive: true, force: true });
  }
});

test("pdf inputs fall back to MarkItDown when PaddleOCR is disabled", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  const previous = process.env.OKF_OBSIDIAN_DISABLE_PADDLEOCR;
  const restore = useMockMediaExtractor();
  process.env.OKF_OBSIDIAN_DISABLE_PADDLEOCR = "1";
  try {
    const source = path.resolve("examples/sample-pdf.pdf");
    const result = await ingest({ vault, inputPath: source });
    assert.equal(result.sourceType, "pdf");
    const note = await readFile(result.filePath, "utf8");
    assert.match(note, /OpenClaw PDF OCR fallback verification/);
    assert.match(note, /source_type:\s+['"]?pdf/);
  } finally {
    restore();
    if (previous === undefined) {
      delete process.env.OKF_OBSIDIAN_DISABLE_PADDLEOCR;
    } else {
      process.env.OKF_OBSIDIAN_DISABLE_PADDLEOCR = previous;
    }
    await rm(vault, { recursive: true, force: true });
  }
});

test("doctor reports paddleocr and markitdown availability", async () => {
  const { runExtractorDoctor } = await import("../src/extract.js");
  const result = await runExtractorDoctor({
    run: async (_command, args, options) => ({
      stdout: `${String(args[1]).match(/import ([a-z_]+)/)?.[1] || "module"}\n`,
      stderr: "",
      stage: options.stage
    })
  });
  assert.equal(result.ok, true);
  assert.match(result.markitdown, /markitdown/);
  assert.match(result.paddleocr, /paddleocr/);
  assert.match(result.fasterWhisper, /faster_whisper/);
  assert.match(result.funasr, /funasr/);
  assert.equal(result.timeouts.probeMs, 20_000);
  assert.equal(result.timeouts.transcriptionMs, 600_000);
});

test("audio inputs can be transcribed into OKF notes", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  const wav = path.join(vault, "speech.wav");
  const restore = useMockMediaExtractor();
  try {
    await writeFile(wav, "mock audio fixture", "utf8");
    const result = await ingest({ vault, inputPath: wav });
    assert.equal(result.sourceType, "audio");
    const note = await readFile(result.filePath, "utf8");
    assert.match(note, /source_type:\s+['"]?audio/);
    assert.match(note, /memory|test|Open/i);
  } finally {
    restore();
    await rm(vault, { recursive: true, force: true });
  }
});

test("video inputs can be transcribed into OKF notes", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  const mp4 = path.join(vault, "speech.mp4");
  const restore = useMockMediaExtractor();
  try {
    await writeFile(mp4, "mock video fixture", "utf8");
    const result = await ingest({ vault, inputPath: mp4 });
    assert.equal(result.sourceType, "video");
    const note = await readFile(result.filePath, "utf8");
    assert.match(note, /source_type:\s+['"]?video/);
    assert.match(note, /memory|test|Open/i);
  } finally {
    restore();
    await rm(vault, { recursive: true, force: true });
  }
});

test("douyin downloader output can be transcribed and written as an OKF note", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-vault-"));
  const sourceVideo = path.join(vault, "source-douyin.mp4");
  const previous = process.env.OKF_DOUYIN_DOWNLOADER_SCRIPT;
  const restore = useMockMediaExtractor();
  process.env.OKF_DOUYIN_DOWNLOADER_SCRIPT = path.resolve("scripts/mock_douyin_download.py");
  try {
    await writeFile(sourceVideo, "mock douyin video fixture", "utf8");
    const downloaded = await downloadDouyin({
      input: sourceVideo,
      outputDir: path.join(vault, "media", "douyin")
    });
    assert.equal(downloaded.ok, true);
    const result = await ingest({ vault, inputPath: downloaded.filePath, sourceType: "video" });
    assert.equal(result.sourceType, "video");
    const note = await readFile(result.filePath, "utf8");
    assert.match(note, /source_type:\s+['"]?video/);
    assert.match(note, /memory|test|douyin|Open/i);
  } finally {
    restore();
    if (previous === undefined) {
      delete process.env.OKF_DOUYIN_DOWNLOADER_SCRIPT;
    } else {
      process.env.OKF_DOUYIN_DOWNLOADER_SCRIPT = previous;
    }
    await rm(vault, { recursive: true, force: true });
  }
});

test("looksLikeDouyin identifies douyin links", () => {
  assert.equal(looksLikeDouyin("https://v.douyin.com/abcd/"), true);
  assert.equal(looksLikeDouyin("https://example.com"), false);
});

function actionFixtureNote(title, body) {
  return {
    title,
    description: body,
    tags: ["okf", "openclaw", "ontology", "duplicate"],
    type: "Concept",
    timestamp: "2026-06-23T00:00:00.000Z",
    resource: "inline-input",
    confidence: 0.8,
    source_type: "text",
    path: `concepts/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
    body
  };
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function useMockMediaExtractor() {
  const keys = ["OKF_EXTRACTOR_EXECUTABLE", "OKF_TRANSCRIBE_SCRIPT", "OKF_PADDLEOCR_SCRIPT", "OKF_MARKITDOWN_SCRIPT"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.OKF_EXTRACTOR_EXECUTABLE = process.execPath;
  process.env.OKF_TRANSCRIBE_SCRIPT = MOCK_MEDIA_EXTRACTOR;
  process.env.OKF_PADDLEOCR_SCRIPT = MOCK_MEDIA_EXTRACTOR;
  process.env.OKF_MARKITDOWN_SCRIPT = MOCK_MEDIA_EXTRACTOR;
  return () => {
    for (const key of keys) restoreEnv(key, previous[key]);
  };
}

function mockNativeEmbeddingProvider(model, dimensions, calls) {
  const vectorFor = (text) => {
    const vector = new Array(dimensions).fill(0);
    vector[String(text).length % dimensions] = 1;
    return vector;
  };
  return {
    id: "test-native",
    model,
    embedBatch: async (texts) => {
      calls.push(texts.length);
      return texts.map(vectorFor);
    },
    embedQuery: async (text) => vectorFor(text)
  };
}
