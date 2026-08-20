import { actionQueueExecute, actionQueueList, actionQueueUpdate, actionQueueValidate, daily, ingest, obsidianViewsExport, okfExport, okfValidate, ontologyValidate, recall, sqliteIndexRebuild } from "../src/core.js";
import path from "node:path";
import { downloadDouyin } from "../src/douyin.js";
import { runExtractorDoctor } from "../src/extract.js";

export async function okf_obsidian_ingest(args) {
  return ingest(args);
}

export async function okf_obsidian_daily(args) {
  return daily(args);
}

export async function okf_obsidian_recall(args) {
  return recall(args);
}

export async function okf_obsidian_sqlite_index(args) {
  return sqliteIndexRebuild(args);
}

export async function okf_obsidian_douyin(args) {
  const outputDir = args.outputDir || path.join(args.vault || ".", "media", "douyin");
  const downloaded = await downloadDouyin({
    input: args.url || args.text || args.input,
    outputDir
  });
  const result = await ingest({
    vault: args.vault,
    inputPath: downloaded.filePath,
    sourceType: "video",
    title: args.title
  });
  return { ...result, downloaded };
}

export async function okf_obsidian_doctor() {
  return runExtractorDoctor();
}

export async function okf_obsidian_okf_validate(args) {
  return okfValidate(args);
}

export async function okf_obsidian_ontology_validate(args) {
  return ontologyValidate(args);
}

export async function okf_obsidian_actions_validate(args) {
  return actionQueueValidate(args);
}

export async function okf_obsidian_actions_list(args) {
  return actionQueueList(args);
}

export async function okf_obsidian_action_update(args) {
  return actionQueueUpdate(args);
}

export async function okf_obsidian_action_execute(args) {
  return actionQueueExecute(args);
}

export async function okf_obsidian_obsidian_views(args) {
  return obsidianViewsExport(args);
}

export async function okf_obsidian_okf_export(args) {
  return okfExport(args);
}

export default {
  tools: {
    okf_obsidian_ingest,
    okf_obsidian_daily,
    okf_obsidian_recall,
    okf_obsidian_sqlite_index,
    okf_obsidian_douyin,
    okf_obsidian_doctor,
    okf_obsidian_okf_validate,
    okf_obsidian_ontology_validate,
    okf_obsidian_actions_validate,
    okf_obsidian_actions_list,
    okf_obsidian_action_update,
    okf_obsidian_action_execute,
    okf_obsidian_obsidian_views,
    okf_obsidian_okf_export
  }
};
