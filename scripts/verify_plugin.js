import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import nativePlugin from "../plugin/native.js";
import legacyPlugin from "../plugin/index.js";

const metadata = getToolPluginMetadata(nativePlugin);
if (!metadata) throw new Error("Native plugin metadata is missing");

const expectedTools = [
  "okf_obsidian_ingest",
  "okf_obsidian_daily",
  "okf_obsidian_recall",
  "okf_obsidian_sqlite_index",
  "okf_obsidian_douyin",
  "okf_obsidian_doctor",
  "okf_obsidian_okf_validate",
  "okf_obsidian_ontology_validate",
  "okf_obsidian_actions_validate",
  "okf_obsidian_actions_list",
  "okf_obsidian_action_update",
  "okf_obsidian_action_execute",
  "okf_obsidian_obsidian_views",
  "okf_obsidian_okf_export"
];

const toolNames = metadata.tools.map((tool) => tool.name);
for (const name of expectedTools) {
  if (!toolNames.includes(name)) throw new Error(`Missing native tool: ${name}`);
}

const vault = await mkdtemp(path.join(os.tmpdir(), "okf-plugin-"));
try {
  const ingestResult = await legacyPlugin.tools.okf_obsidian_ingest({
    vault,
    text: "OpenClaw native plugin verification writes OKF notes for durable memory.",
    sourceType: "text"
  });
  if (!ingestResult.ok) throw new Error("Ingest tool failed");
  const secondIngestResult = await legacyPlugin.tools.okf_obsidian_ingest({
    vault,
    text: "OpenClaw native plugin verification writes OKF notes for durable memory review.",
    sourceType: "text"
  });
  if (!secondIngestResult.ok) throw new Error("Second ingest tool failed");

  const recallResult = await legacyPlugin.tools.okf_obsidian_recall({
    vault,
    query: "native plugin"
  });
  if (!recallResult.ok || recallResult.matches.length < 1) throw new Error("Recall tool failed");
  if (!Array.isArray(recallResult.sqliteMatches)) throw new Error("Recall result is missing sqliteMatches");

  const sqliteResult = await legacyPlugin.tools.okf_obsidian_sqlite_index({ vault });
  if (!sqliteResult.dbPath) throw new Error(`SQLite index tool did not return dbPath: ${JSON.stringify(sqliteResult)}`);

  const index = await readFile(path.join(vault, "index.md"), "utf8");
  if (!index.includes("OpenClaw native plugin verification")) {
    throw new Error("Index did not include ingested note");
  }

  const validateResult = await legacyPlugin.tools.okf_obsidian_okf_validate({ vault });
  if (!validateResult.ok) throw new Error(`OKF validation failed: ${JSON.stringify(validateResult.issues)}`);

  const ontologyResult = await legacyPlugin.tools.okf_obsidian_ontology_validate({ vault });
  if (!ontologyResult.ok) throw new Error(`Ontology validation failed: ${JSON.stringify(ontologyResult.issues)}`);

  const actionsResult = await legacyPlugin.tools.okf_obsidian_actions_validate({ vault });
  if (!actionsResult.ok) throw new Error(`Action queue validation failed: ${JSON.stringify(actionsResult.issues)}`);

  const actionsList = await legacyPlugin.tools.okf_obsidian_actions_list({ vault, limit: 5 });
  if (!actionsList.ok) throw new Error("Action list tool failed");
  if (actionsList.actions.length > 0) {
    const updatedAction = await legacyPlugin.tools.okf_obsidian_action_update({
      vault,
      id: actionsList.actions[0].id,
      status: "accepted",
      note: "verify plugin action lifecycle"
    });
    if (!updatedAction.ok || updatedAction.action.status !== "accepted") {
      throw new Error(`Action update tool failed: ${JSON.stringify(updatedAction)}`);
    }
    const executedAction = await legacyPlugin.tools.okf_obsidian_action_execute({
      vault,
      id: actionsList.actions[0].id
    });
    if (!executedAction.ok || !executedAction.artifact?.path) {
      throw new Error(`Action execute tool failed: ${JSON.stringify(executedAction)}`);
    }
  }

  const exportResult = await legacyPlugin.tools.okf_obsidian_okf_export({ vault });
  if (!exportResult.ok || exportResult.exported < 1) throw new Error("Strict OKF export failed");

  const viewsResult = await legacyPlugin.tools.okf_obsidian_obsidian_views({ vault });
  if (!viewsResult.ok || !viewsResult.canvasPath || !viewsResult.basePath) {
    throw new Error(`Obsidian views export failed: ${JSON.stringify(viewsResult)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    nativeTools: toolNames,
    verifiedVault: vault,
    note: ingestResult.filePath
  }, null, 2));
} finally {
  await rm(vault, { recursive: true, force: true });
}
