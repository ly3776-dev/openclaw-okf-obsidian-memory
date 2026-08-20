import path from "node:path";
import crypto from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { ensureConfig, loadConfig } from "./config.js";
import { extractInput } from "./extract.js";
import { ACTION_STATUSES, buildActionQueue, renderActionQueueMarkdown, summarizeActionQueue, updateActionStatus, validateActionQueue } from "./actionQueue.js";
import { buildOntologyGraph, rankOntologyRecall, renderOntologySynthesis, validateOntologyGraph } from "./ontology.js";
import { runOntologyLlm } from "./llm.js";
import { runWebEnrichment } from "./enrich.js";
import { buildVectorIndex, loadOrBuildVectorIndex, rankVectorRecall } from "./vector.js";
import { exportStrictOkf, validateOkfVault } from "./okf.js";
import { writeObsidianViews } from "./obsidianViews.js";
import { buildSqliteIndex, rankSqliteRecall, updateSqliteIndex } from "./sqliteIndex.js";
import { atomicWriteFile, atomicWriteJson, vaultWriteLockPath, withFileLock } from "./fsSafe.js";

const OKF_VERSION = "0.1";

export async function ingest({ vault, text = "", inputPath, sourceType = "auto", title, useWeb = false } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  await ensureVaultLayout(vault, config);
  const extracted = await extractInput({ text, inputPath, sourceType });
  const normalized = normalizeText(extracted.text);
  if (!normalized) throw new Error("ingest requires text or an input file with text content");
  const enrichment = await runWebEnrichment({
    text: normalized,
    title: title || extracted.title,
    enabled: useWeb || isAmbiguousCapture(normalized)
  });
  const enrichedText = enrichment.text ? `${normalized}\n\n# Web Enrichment\n\n${enrichment.text}` : normalized;

  const note = buildNote({
    text: enrichedText,
    inputPath: extracted.inputPath,
    sourceType: extracted.sourceType,
    title: title || extracted.title,
    extraCitations: enrichment.citations
  });
  const notesDir = path.join(vault, config.notesDir);

  const filename = `${note.slug}.md`;
  const filePath = path.join(notesDir, filename);
  return withVaultWriteLock(vault, config, async () => {
    const previousIndex = await loadOrBuildIndex(vault, config);
    await atomicWriteFile(filePath, renderNote(note), { encoding: "utf8" });
    const index = await updateIndexForFile(vault, config, previousIndex, filePath);
    const vectorIndex = await buildVectorIndex({ vault, config, notes: index.notes, sourceGeneration: index.generation });
    const changedNote = index.notes.find((item) => item.path === path.relative(vault, filePath).replaceAll("\\", "/"));
    const sqliteIndex = await updateSqliteIndex({
      vault,
      config,
      changedNotes: changedNote ? [changedNote] : [],
      deletedPaths: [],
      previousGeneration: previousIndex.generation,
      sourceGeneration: index.generation,
      allNotes: index.notes
    });
    assertDerivedWriteSucceeded(sqliteIndex, "SQLite index");

    return {
      ok: true,
      filePath,
      title: note.frontmatter.title,
      slug: note.slug,
      indexCount: index.notes.length,
      sourceType: extracted.sourceType,
      warnings: [...(extracted.warnings || []), ...(enrichment.ok === false ? [enrichment.reason] : [])],
      enrichment,
      vector: {
        entries: vectorIndex.entries.length,
        indexPath: path.join(vault, config.cacheDir, "vector-index.json")
      },
      sqlite: {
        ok: sqliteIndex.ok,
        skipped: Boolean(sqliteIndex.skipped),
        dbPath: sqliteIndex.dbPath,
        reason: sqliteIndex.reason || ""
      }
    };
  });
}

export async function daily({ vault, useLlm = false } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  await ensureVaultLayout(vault, config);
  return withVaultWriteLock(vault, config, async () => {
    const index = await rebuildIndex(vault, config);
    const graph = withSourceGeneration(buildOntologyGraph(index.notes), index.generation);
    const ontologyValidation = validateOntologyGraph(graph);
    const previousActionQueue = await loadActionQueue(vault, config);
    const actionQueue = buildActionQueue({ graph, previousQueue: previousActionQueue });
    const actionQueueValidation = validateActionQueue(actionQueue, graph);
    const vectorIndex = await buildVectorIndex({ vault, config, notes: index.notes, sourceGeneration: index.generation });
    const sqliteIndex = await buildSqliteIndex({ vault, config, notes: index.notes, graph, actionQueue, sourceGeneration: index.generation });
    assertDerivedWriteSucceeded(sqliteIndex, "SQLite index");
    const llm = await runOntologyLlm({ vault, graph, notes: index.notes, enabled: useLlm });
    await writeOntologyGraph(vault, config, graph);
    await writeActionQueue(vault, config, actionQueue, graph);
    const obsidianViews = await writeObsidianViews({ vault, config, graph, actionQueue });
    const dailyDir = path.join(vault, config.dailyDir);
    await mkdir(dailyDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(dailyDir, `${date}-synthesis.md`);
    await atomicWriteFile(filePath, renderOntologySynthesis(date, index.notes, graph, llm), { encoding: "utf8" });
    return {
    ok: true,
    filePath,
    notes: index.notes.length,
    ontology: {
      objects: graph.objects.length,
      links: graph.links.length,
      actions: graph.actions.length,
      graphPath: path.join(vault, config.cacheDir, "ontology.json"),
      validation: ontologyValidation
    },
    actionQueue: {
      actions: actionQueue.actions.length,
      active: actionQueueValidation.summary.active,
      queuePath: path.join(vault, config.cacheDir, "ontology-actions.json"),
      markdownPath: path.join(vault, config.synthesesDir, "ontology-actions.md"),
      validation: actionQueueValidation
    },
    obsidianViews: {
      canvasPath: obsidianViews.canvasPath,
      basePath: obsidianViews.basePath,
      actionNotesDir: obsidianViews.actionNotesDir,
      actionNotes: obsidianViews.actionNotes
    },
    vector: {
      entries: vectorIndex.entries.length,
      indexPath: path.join(vault, config.cacheDir, "vector-index.json")
    },
    sqlite: {
      ok: sqliteIndex.ok,
      skipped: Boolean(sqliteIndex.skipped),
      dbPath: sqliteIndex.dbPath,
      reason: sqliteIndex.reason || ""
    },
    llm
    };
  });
}

export async function recall({ vault, query = "", limit = 5 } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  await ensureVaultLayout(vault, config);
  return withVaultWriteLock(vault, config, async () => {
  const index = await loadOrBuildIndex(vault, config);
  const graph = await loadOrBuildOntology(vault, config, index.notes, index.generation);
  const vectorIndex = await loadOrBuildVectorIndex({ vault, config, notes: index.notes, sourceGeneration: index.generation });
  const sqliteMatches = await rankSqliteRecall({ vault, config, query, limit, sourceGeneration: index.generation });
  const ontologyMatches = rankOntologyRecall(graph, query, limit);
  const vectorMatches = await rankVectorRecall(vectorIndex, query, limit, config);
  const tokens = tokenize(query);
  const matches = index.notes
    .map((note) => ({ ...note, score: scoreNote(note, tokens) }))
    .filter((note) => note.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ body, ...note }) => note);

  return {
    ok: true,
    query,
    matches,
    sqliteMatches,
    ontologyMatches,
    vectorMatches,
    fusedMatches: fuseMatches({ matches, sqliteMatches, ontologyMatches, vectorMatches, limit })
  };
  });
}

export async function okfValidate({ vault } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  return validateOkfVault({ vault, notesDir: config.notesDir, strictLinks: true });
}

export async function ontologyValidate({ vault } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  await ensureVaultLayout(vault, config);
  return withVaultWriteLock(vault, config, async () => {
  const index = await loadOrBuildIndex(vault, config);
  const graph = await loadOrBuildOntology(vault, config, index.notes, index.generation);
  return {
    ...validateOntologyGraph(graph),
    graphPath: path.join(vault, config.cacheDir, "ontology.json")
  };
  });
}

export async function actionQueueValidate({ vault } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  await ensureVaultLayout(vault, config);
  return withVaultWriteLock(vault, config, async () => {
  const index = await loadOrBuildIndex(vault, config);
  const graph = await loadOrBuildOntology(vault, config, index.notes, index.generation);
  const queue = await loadOrBuildActionQueue(vault, config, graph);
  return {
    ...validateActionQueue(queue, graph),
    queuePath: path.join(vault, config.cacheDir, "ontology-actions.json")
  };
  });
}

export async function actionQueueList({ vault, status, limit = 20 } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  await ensureVaultLayout(vault, config);
  return withVaultWriteLock(vault, config, async () => {
  const index = await loadOrBuildIndex(vault, config);
  const graph = await loadOrBuildOntology(vault, config, index.notes, index.generation);
  const queue = await loadOrBuildActionQueue(vault, config, graph);
  const normalizedStatus = status ? String(status).trim() : "";
  if (normalizedStatus && !ACTION_STATUSES.includes(normalizedStatus)) {
    throw new Error(`invalid action status: ${normalizedStatus}`);
  }
  const max = clampNumber(limit, 1, 100, 20);
  const actions = queue.actions
    .filter((action) => !normalizedStatus || action.status === normalizedStatus)
    .slice(0, max);
  return {
    ok: true,
    actionQueueVersion: queue.action_queue_version,
    summary: summarizeActionQueue(queue),
    actions,
    queuePath: path.join(vault, config.cacheDir, "ontology-actions.json"),
    markdownPath: path.join(vault, config.synthesesDir, "ontology-actions.md")
  };
  });
}

export async function actionQueueUpdate({ vault, id, status, note = "" } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  await ensureVaultLayout(vault, config);
  return withVaultWriteLock(vault, config, async () => {
  const index = await loadOrBuildIndex(vault, config);
  const graph = await loadOrBuildOntology(vault, config, index.notes, index.generation);
  const queue = await loadOrBuildActionQueue(vault, config, graph);
  const updated = updateActionStatus(queue, { id, status, note });
  const validation = validateActionQueue(updated.queue, graph);
  if (!validation.ok) {
    return {
      ok: false,
      action: updated.action,
      validation,
      queuePath: path.join(vault, config.cacheDir, "ontology-actions.json")
    };
  }
  await writeActionQueue(vault, config, updated.queue, graph);
  const obsidianViews = await writeObsidianViews({ vault, config, graph, actionQueue: updated.queue });
  return {
    ok: true,
    action: updated.action,
    summary: summarizeActionQueue(updated.queue),
    validation,
    queuePath: path.join(vault, config.cacheDir, "ontology-actions.json"),
    markdownPath: path.join(vault, config.synthesesDir, "ontology-actions.md"),
    obsidianViews
  };
  });
}

export async function actionQueueExecute({ vault, id } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  await ensureVaultLayout(vault, config);
  return withVaultWriteLock(vault, config, async () => {
  const index = await loadOrBuildIndex(vault, config);
  const graph = await loadOrBuildOntology(vault, config, index.notes, index.generation);
  const queue = await loadOrBuildActionQueue(vault, config, graph);
  const action = queue.actions.find((item) => item.id === id);
  if (!action) throw new Error(`Action not found: ${id || ""}`);

  const artifact = await executeOntologyAction({ vault, config, graph, action });
  const relativeArtifactPath = path.relative(vault, artifact.filePath).replaceAll("\\", "/");
  const updated = updateActionStatus(queue, {
    id,
    status: artifact.nextStatus,
    note: `created lifecycle artifact: ${relativeArtifactPath}`
  });
  const validation = validateActionQueue(updated.queue, graph);
  if (!validation.ok) {
    return {
      ok: false,
      action: updated.action,
      artifact: { ...artifact, path: relativeArtifactPath },
      validation,
      queuePath: path.join(vault, config.cacheDir, "ontology-actions.json")
    };
  }
  await writeActionQueue(vault, config, updated.queue, graph);
  const obsidianViews = await writeObsidianViews({ vault, config, graph, actionQueue: updated.queue });
  return {
    ok: true,
    action: updated.action,
    artifact: { ...artifact, path: relativeArtifactPath },
    summary: summarizeActionQueue(updated.queue),
    validation,
    queuePath: path.join(vault, config.cacheDir, "ontology-actions.json"),
    markdownPath: path.join(vault, config.synthesesDir, "ontology-actions.md"),
    obsidianViews
  };
  });
}

export async function obsidianViewsExport({ vault } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  await ensureVaultLayout(vault, config);
  return withVaultWriteLock(vault, config, async () => {
  const index = await loadOrBuildIndex(vault, config);
  const graph = await loadOrBuildOntology(vault, config, index.notes, index.generation);
  const actionQueue = await loadOrBuildActionQueue(vault, config, graph);
  const views = await writeObsidianViews({ vault, config, graph, actionQueue });
  return {
    ok: true,
    canvasPath: views.canvasPath,
    basePath: views.basePath,
    actionNotesDir: views.actionNotesDir,
    actionNotes: views.actionNotes
  };
  });
}

export async function sqliteIndexRebuild({ vault } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  await ensureVaultLayout(vault, config);
  return withVaultWriteLock(vault, config, async () => {
  const index = await loadOrBuildIndex(vault, config);
  const graph = await loadOrBuildOntology(vault, config, index.notes, index.generation);
  const actionQueue = await loadOrBuildActionQueue(vault, config, graph);
  const sqlite = await buildSqliteIndex({ vault, config, notes: index.notes, graph, actionQueue, sourceGeneration: index.generation });
  return {
    ok: sqlite.ok,
    skipped: Boolean(sqlite.skipped),
    dbPath: sqlite.dbPath,
    notes: sqlite.notes || index.notes.length,
    objects: sqlite.objects || graph.objects.length,
    links: sqlite.links || graph.links.length,
    actions: sqlite.actions || actionQueue.actions.length,
    reason: sqlite.reason || ""
  };
  });
}

export async function okfExport({ vault, outputDir } = {}) {
  assertVault(vault);
  const config = await loadConfig(vault);
  return exportStrictOkf({ vault, outputDir, notesDir: config.notesDir });
}

export function buildNote({ text, inputPath, sourceType = "text", title, extraCitations = [] } = {}) {
  const summary = summarize(text);
  const derivedTitle = title || titleFromSummary(summary);
  const slug = uniqueSlug(derivedTitle, text);
  const keywords = extractKeywords(text).slice(0, 8);
  const now = new Date().toISOString();

  return {
    slug,
    frontmatter: {
      type: "Concept",
      title: derivedTitle,
      description: summary,
      resource: inputPath || "inline-input",
      tags: [...new Set(["okf", "openclaw", ...keywords.slice(0, 5)])],
      timestamp: now,
      okf_version: OKF_VERSION,
      confidence: 0.72,
      source_type: sourceType,
      source_inputs: inputPath ? [inputPath] : ["inline-input"],
      aliases: [],
      related: []
    },
    sections: {
      summary,
      keyClaims: extractSentences(text).slice(0, 5),
      context: text,
      relatedConcepts: keywords,
      openQuestions: inferOpenQuestions(text),
      citations: [...(inputPath ? [`Local source: ${inputPath}`] : ["User-provided inline input"]), ...extraCitations]
    }
  };
}

export function renderNote(note) {
  const fm = renderFrontmatter(note.frontmatter);
  const claims = note.sections.keyClaims.map((claim) => `- ${claim}`).join("\n") || "- No clear claims extracted.";
  const related = note.sections.relatedConcepts.map((item) => `- ${item}`).join("\n") || "- None yet.";
  const questions = note.sections.openQuestions.map((item) => `- ${item}`).join("\n") || "- None.";
  const citations = note.sections.citations.map((item) => `- ${item}`).join("\n");

  return `${fm}

# ${note.frontmatter.title}

## 一句话结论 / One-Line Takeaway

${note.sections.summary}

## 适合什么时候用 / When To Use

- OpenClaw 需要回忆这条知识、来源、决策背景或后续动作时。
- 人在 Obsidian 里复盘相关主题、实体、项目或操作流程时。

## 关键要点 / Key Points

${claims}

## 原始内容摘要 / Source Summary

- Source / 来源: ${note.frontmatter.resource}
- Source type / 来源类型: ${note.frontmatter.source_type}
- Confidence / 置信度: ${note.frontmatter.confidence}
- Captured / 记录时间: ${note.frontmatter.timestamp}

## 关联 / Related

${related}

## 待确认问题 / Open Questions

${questions}

## 引用 / Citations

${citations}

## 原始上下文 / Original Context

${note.sections.context}

# Machine Notes

- OKF version: ${note.frontmatter.okf_version}
- Source inputs: ${(note.frontmatter.source_inputs || []).join(", ")}
`;
}

async function loadOrBuildIndex(vault, config) {
  const indexPath = path.join(vault, config.cacheDir, "index.json");
  try {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    if (await indexMatchesVault(vault, config, index)) return index;
  } catch {
    // Rebuild below.
  }
  return rebuildIndex(vault, config);
}

async function rebuildIndex(vault, config) {
  const notes = await readNotes(vault, config);
  const index = {
    indexVersion: "0.2",
    generatedAt: new Date().toISOString(),
    generation: sourceGeneration(notes),
    notes
  };
  await mkdir(path.join(vault, config.cacheDir), { recursive: true });
  await atomicWriteJson(path.join(vault, config.cacheDir, "index.json"), index);
  await atomicWriteFile(path.join(vault, "index.md"), renderIndex(notes), { encoding: "utf8" });
  return index;
}

async function updateIndexForFile(vault, config, previousIndex, filePath) {
  const details = await stat(filePath);
  const descriptor = {
    filePath,
    relativePath: path.relative(vault, filePath).replaceAll("\\", "/"),
    size: details.size,
    mtimeMs: details.mtimeMs
  };
  const changed = await readIndexedNote(descriptor);
  const byPath = new Map((previousIndex?.notes || []).map((note) => [note.path, note]));
  byPath.set(changed.path, changed);
  const notes = [...byPath.values()].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const index = {
    indexVersion: "0.2",
    generatedAt: new Date().toISOString(),
    generation: sourceGeneration(notes),
    notes,
    update: { mode: "incremental", changed: [changed.path], deleted: [] }
  };
  await atomicWriteJson(path.join(vault, config.cacheDir, "index.json"), index);
  await atomicWriteFile(path.join(vault, "index.md"), renderIndex(notes), { encoding: "utf8" });
  return index;
}

async function writeOntologyGraph(vault, config, graph) {
  await mkdir(path.join(vault, config.cacheDir), { recursive: true });
  await atomicWriteJson(path.join(vault, config.cacheDir, "ontology.json"), graph);
}

async function writeActionQueue(vault, config, queue, graph) {
  await mkdir(path.join(vault, config.cacheDir), { recursive: true });
  await mkdir(path.join(vault, config.synthesesDir), { recursive: true });
  queue.sourceGeneration = graph.sourceGeneration || "";
  await atomicWriteJson(path.join(vault, config.cacheDir, "ontology-actions.json"), queue);
  await atomicWriteFile(path.join(vault, config.synthesesDir, "ontology-actions.md"), renderActionQueueMarkdown(queue, graph), { encoding: "utf8" });
}

async function loadActionQueue(vault, config) {
  try {
    return JSON.parse(await readFile(path.join(vault, config.cacheDir, "ontology-actions.json"), "utf8"));
  } catch {
    return null;
  }
}

async function loadOrBuildActionQueue(vault, config, graph) {
  const existing = await loadActionQueue(vault, config);
  if (existing?.sourceGeneration === graph.sourceGeneration) return existing;
  const queue = buildActionQueue({ graph, previousQueue: existing });
  await writeActionQueue(vault, config, queue, graph);
  return queue;
}

async function loadOrBuildOntology(vault, config, notes, generation) {
  const graphPath = path.join(vault, config.cacheDir, "ontology.json");
  try {
    const graph = JSON.parse(await readFile(graphPath, "utf8"));
    if (graph.sourceGeneration === generation && graph.adjacency?.version === 2) return graph;
  } catch {
    // Rebuild below.
  }
  const graph = withSourceGeneration(buildOntologyGraph(notes), generation);
  await writeOntologyGraph(vault, config, graph);
  return graph;
}

async function executeOntologyAction({ vault, config, graph, action }) {
  const objectById = new Map((graph.objects || []).map((object) => [object.id, object]));
  if (action.type === "promote_entity_note") {
    return writePromotedEntityNote({ vault, config, graph, action, objectById });
  }
  if (action.type === "merge_duplicate_concepts") {
    return writeActionReviewArtifact({
      vault,
      config,
      graph,
      action,
      objectById,
      kind: "merge_review",
      nextStatus: "in_progress",
      title: "Merge Review",
      heading: "Merge Review / 合并复核",
      body: "Review whether these concepts represent duplicates, parent-child knowledge, or simply related ideas before editing source notes."
    });
  }
  if (action.type === "enrich_ambiguous_concept") {
    return writeActionReviewArtifact({
      vault,
      config,
      graph,
      action,
      objectById,
      kind: "enrichment_review",
      nextStatus: "in_progress",
      title: "Enrichment Review",
      heading: "Enrichment Review / 补全复核",
      body: "Use web research or LLM review to add missing context and citations, then update the target concept note."
    });
  }
  return writeActionReviewArtifact({
    vault,
    config,
    graph,
    action,
    objectById,
    kind: "human_review",
    nextStatus: "in_progress",
    title: "Ontology Review",
    heading: "Ontology Review / Ontology 复核",
    body: "Review this ontology maintenance action and decide whether to complete, dismiss, or archive it."
  });
}

async function writePromotedEntityNote({ vault, config, graph, action, objectById }) {
  const entity = objectById.get(action.targets[0]);
  if (!entity || entity.type !== "Entity") {
    throw new Error(`promote_entity_note target must be an Entity: ${action.targets[0] || ""}`);
  }
  const mentions = (graph.links || [])
    .filter((linkItem) => linkItem.type === "mentions" && linkItem.to === entity.id)
    .map((linkItem) => objectById.get(linkItem.from))
    .filter(Boolean);
  const title = entity.properties.name;
  const body = renderActionArtifact({
    frontmatter: {
      type: "Entity",
      title,
      name: title,
      kind: entity.properties.kind || "Entity",
      description: `Promoted ontology entity for ${title}.`,
      timestamp: new Date().toISOString(),
      okf_version: OKF_VERSION,
      ontology_version: "0.1",
      source_action: action.id,
      aliases: []
    },
    heading: `Entity Note / 实体笔记: ${title}`,
    summary: `This entity was promoted from repeated ontology mentions. / 该实体由重复出现的 ontology mention 提升而来。`,
    sections: [
      ["Mentioned By / 被提及于", mentions.map(formatConceptReference)],
      ["Lifecycle Action / 生命周期动作", [`${action.type}: ${action.description}`, `Action ID: ${action.id}`]]
    ]
  });
  const slug = uniqueSlug(title, `${entity.id}\n${action.id}`);
  const filePath = path.join(vault, config.entitiesDir, `${slug}.md`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, body, { encoding: "utf8" });
  return {
    kind: "entity_note",
    nextStatus: "done",
    filePath,
    title
  };
}

async function writeActionReviewArtifact({ vault, config, action, objectById, kind, nextStatus, title, heading, body }) {
  const targets = (action.targets || []).map((target) => objectById.get(target)).filter(Boolean);
  const artifactTitle = `${title}: ${targets.map((target) => objectTitle(target)).join(" + ") || action.type}`;
  const markdown = renderActionArtifact({
    frontmatter: {
      type: "Synthesis",
      title: artifactTitle,
      description: action.description,
      timestamp: new Date().toISOString(),
      okf_version: OKF_VERSION,
      ontology_version: "0.1",
      source_action: action.id,
      action_type: action.type,
      action_status: nextStatus
    },
    heading,
    summary: body,
    sections: [
      ["Action / 动作", [`${action.type}: ${action.description}`, `Priority: ${action.priority}`, `Confidence: ${action.confidence}`]],
      ["Targets / 目标", targets.map(formatOntologyObjectReference)],
      ["Next Step / 下一步", [`Update status with: node ./src/cli.js action-update --vault <vault> --id ${action.id} --status done`]]
    ]
  });
  const filename = `${safeActionFilename(action.id)}-${kind}.md`;
  const filePath = path.join(vault, config.synthesesDir, filename);
  await mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, markdown, { encoding: "utf8" });
  return {
    kind,
    nextStatus,
    filePath,
    title: artifactTitle
  };
}

async function readNotes(vault, config) {
  const files = await scanNoteFiles(vault, config);
  const notes = [];
  for (const file of files) {
    notes.push(await readIndexedNote(file));
  }
  return notes.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

async function readIndexedNote(file) {
  const raw = await readFile(file.filePath, "utf8");
  const parsed = parseNote(raw);
  return {
      title: parsed.data.title || path.basename(file.relativePath, ".md"),
      description: typeof parsed.data.description === "string" ? parsed.data.description : "",
      tags: normalizeFrontmatterTags(parsed.data.tags),
      type: parsed.data.type || "Note",
      timestamp: String(parsed.data.timestamp || ""),
      resource: parsed.data.resource || "",
      confidence: Number(parsed.data.confidence || 0),
      source_type: parsed.data.source_type || "",
      path: file.relativePath,
      body: parsed.body,
      frontmatterError: parsed.error || null,
      file: {
        size: file.size,
        mtimeMs: file.mtimeMs,
        sha256: crypto.createHash("sha256").update(raw).digest("hex")
      }
  };
}

async function scanNoteFiles(vault, config) {
  const dirs = [config.notesDir, config.entitiesDir, config.synthesesDir, config.sourcesDir];
  const candidates = [];
  const seen = new Set();
  for (const dir of dirs) {
    const absoluteRoot = path.join(vault, dir);
    await walkMarkdownFiles(absoluteRoot, (filePath) => {
      const relativePath = path.relative(vault, filePath).replaceAll("\\", "/");
      if (seen.has(relativePath) || isGeneratedSynthesisView(dir, config, path.relative(absoluteRoot, filePath))) return;
      seen.add(relativePath);
      candidates.push({ filePath, relativePath });
    });
  }
  const files = [];
  for (let offset = 0; offset < candidates.length; offset += 128) {
    const batch = candidates.slice(offset, offset + 128);
    files.push(...await Promise.all(batch.map(async (file) => {
      const details = await stat(file.filePath);
      return { ...file, size: details.size, mtimeMs: details.mtimeMs };
    })));
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function indexMatchesVault(vault, config, index) {
  if (index?.indexVersion !== "0.2" || !Array.isArray(index.notes) || !index.generation) return false;
  const files = await scanNoteFiles(vault, config);
  if (files.length !== index.notes.length) return false;
  const noteByPath = new Map(index.notes.map((note) => [note.path, note]));
  for (const file of files) {
    const cached = noteByPath.get(file.relativePath);
    if (!cached?.file?.sha256 || cached.file.size !== file.size || cached.file.mtimeMs !== file.mtimeMs) return false;
  }
  return sourceGeneration(index.notes) === index.generation;
}

function sourceGeneration(notes) {
  const hash = crypto.createHash("sha256");
  for (const note of [...notes].sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
    hash.update(`${note.path}\0${note.file?.sha256 || ""}\n`);
  }
  return hash.digest("hex");
}

function withSourceGeneration(graph, generation) {
  graph.sourceGeneration = generation || "";
  return graph;
}

async function walkMarkdownFiles(directory, visit) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const directories = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) directories.push(target);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) visit(target);
  }
  await Promise.all(directories.map((target) => walkMarkdownFiles(target, visit)));
}

function isGeneratedSynthesisView(dir, config, relativePath) {
  const normalizedDir = String(dir || "").replaceAll("\\", "/");
  const synthesesDir = String(config.synthesesDir || "syntheses").replaceAll("\\", "/");
  if (normalizedDir !== synthesesDir) return false;
  const normalizedPath = String(relativePath || "").replaceAll("\\", "/");
  return normalizedPath === "ontology-actions.md" || normalizedPath.startsWith("ontology-action-notes/");
}

function renderIndex(notes) {
  const rows = notes.map((note) => `- [[${note.path.replace(/\.md$/, "")}|${note.title}]] - ${note.description}`).join("\n");
  return `# OKF Vault Index

Generated: ${new Date().toISOString()}

${rows || "No OKF notes yet."}
`;
}

function renderDailySynthesis(date, notes, linked) {
  const recent = notes.slice(0, 10).map((note) => `- [[${note.path.replace(/\.md$/, "")}|${note.title}]] - ${note.description}`).join("\n");
  const links = linked.map((item) => `- [[${item.a.path.replace(/\.md$/, "")}|${item.a.title}]] <-> [[${item.b.path.replace(/\.md$/, "")}|${item.b.title}]] (${item.shared.join(", ")})`).join("\n");
  return `---
type: Synthesis
title: Daily Knowledge Synthesis ${date}
timestamp: ${new Date().toISOString()}
okf_version: "${OKF_VERSION}"
---

# Recent Notes

${recent || "- No notes indexed."}

# Suggested Links

${links || "- No strong link suggestions yet."}

# Maintenance Notes

- Review low-confidence notes manually.
- Promote repeated concepts into dedicated Concept notes.
`;
}

function suggestLinks(notes) {
  const links = [];
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const aTokens = new Set(tokenize(`${notes[i].title} ${notes[i].description} ${(notes[i].tags || []).join(" ")}`));
      const bTokens = new Set(tokenize(`${notes[j].title} ${notes[j].description} ${(notes[j].tags || []).join(" ")}`));
      const shared = [...aTokens].filter((token) => bTokens.has(token) && token.length > 3);
      if (shared.length >= 2) links.push({ a: notes[i], b: notes[j], shared: shared.slice(0, 5) });
    }
  }
  return links;
}

function scoreNote(note, queryTokens) {
  if (!queryTokens.length) return 0;
  const noteTokens = tokenize(`${note.title} ${note.description} ${(note.tags || []).join(" ")} ${note.body}`);
  return queryTokens.reduce((score, token) => score + noteTokens.filter((item) => item === token).length, 0);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function renderActionArtifact({ frontmatter, heading, summary, sections = [] }) {
  const renderedSections = sections.map(([title, rows]) => {
    const list = (rows || []).filter(Boolean).map((row) => `- ${row}`).join("\n");
    return `# ${title}\n\n${list || "- None."}`;
  }).join("\n\n");
  return `${renderFrontmatter(frontmatter)}

# ${heading}

${summary}

${renderedSections}
`;
}

function formatConceptReference(object) {
  if (!object) return "";
  if (object.properties?.path) {
    return `[[${object.properties.path.replace(/\.md$/, "")}|${object.properties.title || object.id}]]`;
  }
  return objectTitle(object);
}

function formatOntologyObjectReference(object) {
  if (!object) return "";
  const title = objectTitle(object);
  if (object.type === "Concept" && object.properties?.path) {
    return `Concept: [[${object.properties.path.replace(/\.md$/, "")}|${title}]]`;
  }
  return `${object.type}: ${title}`;
}

function objectTitle(object) {
  return object?.properties?.title || object?.properties?.name || object?.properties?.resource || object?.id || "";
}

function safeActionFilename(id) {
  return String(id || "action")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "action";
}

function fuseMatches({ matches, sqliteMatches, ontologyMatches, vectorMatches, limit }) {
  const scored = new Map();
  const lexicalScores = normalizeSignalScores(matches);
  const sqliteScores = normalizeSignalScores(sqliteMatches);
  const ontologyScores = normalizeSignalScores(ontologyMatches);
  for (const item of matches || []) {
    addFused(scored, item.path, item.title, item.description, "lexical", lexicalScores.get(item.path) || 0);
  }
  for (const item of sqliteMatches || []) {
    addFused(scored, item.path, item.title, item.description || item.preview, "sqlite", sqliteScores.get(item.path) || 0);
  }
  for (const item of ontologyMatches || []) {
    addFused(scored, item.path, item.title, item.description, "ontology", ontologyScores.get(item.path) || 0);
  }
  for (const item of vectorMatches || []) {
    addFused(scored, item.path, item.title, item.preview, "vector", item.score || 0);
  }
  return [...scored.values()]
    .map((item) => ({ ...item, score: Number(item.score.toFixed(4)), signals: [...item.signals] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function normalizeSignalScores(items) {
  const maximum = Math.max(0, ...(items || []).map((item) => Number(item.score) || 0));
  return new Map((items || []).map((item) => [item.path, maximum > 0 ? (Number(item.score) || 0) / maximum : 0]));
}

function addFused(map, pathValue, title, description, signal, score) {
  if (!pathValue) return;
  const existing = map.get(pathValue) || { path: pathValue, title, description: description || "", score: 0, signals: new Set() };
  existing.score += score;
  existing.signals.add(signal);
  map.set(pathValue, existing);
}

function normalizeText(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function summarize(text) {
  const sentences = extractSentences(text);
  const first = sentences.find((sentence) => sentence.length >= 40) || sentences[0] || text.slice(0, 180);
  return first.length > 220 ? `${first.slice(0, 217)}...` : first;
}

function extractSentences(text) {
  return normalizeText(text)
    .split(/(?<=[.!?。！？])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function titleFromSummary(summary) {
  const words = summary.replace(/[^\p{L}\p{N}\s-]/gu, "").split(/\s+/).filter(Boolean).slice(0, 8);
  return words.join(" ") || "Untitled OKF Note";
}

function uniqueSlug(title, text) {
  const base = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "okf-note";
  const hash = crypto.createHash("sha1").update(`${title}\n${text}`).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

function extractKeywords(text) {
  const stop = new Set(["this", "that", "with", "from", "into", "able", "should", "later", "before", "after", "their", "there", "these", "those", "and", "the", "for", "一个", "可以", "通过", "内容"]);
  const counts = new Map();
  for (const token of tokenize(text)) {
    if (token.length < 3 || stop.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([token]) => token);
}

function inferOpenQuestions(text) {
  const questions = extractSentences(text).filter((sentence) => /[?？]$/.test(sentence));
  return questions.slice(0, 5);
}

function isAmbiguousCapture(text) {
  const normalized = normalizeText(text);
  if (normalized.length < 80) return true;
  return /^(这个|那个|这|那|不清楚|模糊|补充|看看|总结)$/i.test(normalized);
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function assertVault(vault) {
  if (!vault) throw new Error("vault path is required");
}

function withVaultWriteLock(vault, config, work) {
  return withFileLock(vaultWriteLockPath(vault, config), work);
}

function assertDerivedWriteSucceeded(result, label) {
  if (result?.ok || result?.unavailable) return;
  const error = new Error(`${label} write failed: ${result?.reason || "unknown error"}. / ${label} 写入失败：${result?.reason || "未知错误"}。`);
  error.code = "DERIVED_CACHE_WRITE_FAILED";
  error.result = result;
  throw error;
}

async function ensureVaultLayout(vault, config) {
  await ensureConfig(vault);
  await mkdir(path.join(vault, config.notesDir), { recursive: true });
  await mkdir(path.join(vault, config.dailyDir), { recursive: true });
  await mkdir(path.join(vault, config.sourcesDir), { recursive: true });
  await mkdir(path.join(vault, config.entitiesDir), { recursive: true });
  await mkdir(path.join(vault, config.synthesesDir), { recursive: true });
  await mkdir(path.join(vault, config.cacheDir), { recursive: true });
}

function renderFrontmatter(data) {
  const yaml = stringifyYaml(data, {
    lineWidth: 0,
    defaultStringType: "QUOTE_SINGLE",
    defaultKeyType: "PLAIN"
  }).trimEnd();
  return `---\n${yaml}\n---`;
}

function parseNote(raw) {
  const text = String(raw || "");
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { data: {}, body: text };
  const fmText = text.slice(4, end);
  const body = text.slice(end + 5);
  const frontmatter = parseFrontmatter(fmText);
  return { data: frontmatter.data, body, error: frontmatter.error };
}

function parseFrontmatter(text) {
  try {
    const document = parseDocument(String(text || ""), {
      merge: true,
      maxAliasCount: 100,
      prettyErrors: false
    });
    const parsed = document.toJS({ maxAliasCount: 100 });
    return {
      data: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
      error: document.errors.length ? document.errors.map((item) => item.message).join("; ") : null
    };
  } catch (error) {
    return { data: {}, error: error.message };
  }
}

function normalizeFrontmatterTags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}
