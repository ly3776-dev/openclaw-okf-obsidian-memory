#!/usr/bin/env node
import { actionQueueExecute, actionQueueList, actionQueueUpdate, actionQueueValidate, daily, ingest, obsidianViewsExport, okfExport, okfValidate, ontologyValidate, recall, sqliteIndexRebuild } from "./core.js";
import { downloadDouyin } from "./douyin.js";
import { runExtractorDoctor } from "./extract.js";
import path from "node:path";

function parseArgs(argv) {
  let [command, ...rest] = argv;
  if (command && command.startsWith("--")) {
    rest = argv;
    command = undefined;
  }
  const args = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = rest[i + 1];
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
  if (!args.command || args.help) {
    printUsage();
    return;
  }

  if (args.command === "ingest") {
    const result = await ingest({
      vault: args.vault,
      text: args.text,
      inputPath: args.input,
      sourceType: args.sourceType ?? "auto",
      title: args.title,
      useWeb: Boolean(args.useWeb)
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "daily") {
    const result = await daily({ vault: args.vault, useLlm: Boolean(args.useLlm) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "recall") {
    const result = await recall({ vault: args.vault, query: args.query ?? "" });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "sqlite-index") {
    const result = await sqliteIndexRebuild({ vault: args.vault });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok && !result.skipped) process.exitCode = 1;
    return;
  }

  if (args.command === "doctor") {
    const result = await runExtractorDoctor();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "okf-validate") {
    const result = await okfValidate({ vault: args.vault });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "ontology-validate") {
    const result = await ontologyValidate({ vault: args.vault });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "action-validate") {
    const result = await actionQueueValidate({ vault: args.vault });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "action-list") {
    const result = await actionQueueList({ vault: args.vault, status: args.status, limit: args.limit });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "action-update") {
    const result = await actionQueueUpdate({
      vault: args.vault,
      id: args.id,
      status: args.status,
      note: args.note
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "action-execute") {
    const result = await actionQueueExecute({ vault: args.vault, id: args.id });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "okf-export") {
    const result = await okfExport({ vault: args.vault, outputDir: args.outputDir });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "obsidian-views") {
    const result = await obsidianViewsExport({ vault: args.vault });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "douyin") {
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
    console.log(JSON.stringify({ ...result, downloaded }, null, 2));
    return;
  }

  throw new Error(`Unknown command / 未知命令: ${args.command}`);
}

function printUsage() {
  console.log([
    "Usage: okf-obsidian <ingest|daily|recall|sqlite-index|douyin|doctor|ontology-validate|action-validate|action-list|action-update|action-execute|obsidian-views|okf-validate|okf-export> --vault <path> [--input <file>] [--text <text>] [--query <text>]",
    "用法：okf-obsidian <ingest|daily|recall|sqlite-index|douyin|doctor|ontology-validate|action-validate|action-list|action-update|action-execute|obsidian-views|okf-validate|okf-export> --vault <路径> [--input <文件>] [--text <文本>] [--query <查询>]"
  ].join("\n"));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
