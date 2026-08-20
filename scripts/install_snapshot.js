#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { completeInstallSnapshot, createInstallSnapshot, purgeInstallSnapshot, restoreInstallSnapshot } from "../src/installSnapshot.js";

const [command = "", ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
let result;
if (command === "create") {
  if (!args.root || !args.vault) throw new Error("create requires --root and --vault");
  const plan = args.planBase64
    ? JSON.parse(Buffer.from(args.planBase64, "base64").toString("utf8"))
    : (args.planJson ? JSON.parse(args.planJson) : {});
  result = await createInstallSnapshot({
    root: args.root,
    vault: args.vault,
    openclawConfig: args.openclawConfig || path.join(os.homedir(), ".openclaw", "openclaw.json"),
    plan,
    snapshotRoot: args.snapshotRoot
  });
} else if (command === "restore") {
  if (!args.snapshot) throw new Error("restore requires --snapshot");
  result = await restoreInstallSnapshot(args.snapshot);
} else if (command === "complete") {
  if (!args.snapshot) throw new Error("complete requires --snapshot");
  const changes = args.changesBase64
    ? JSON.parse(Buffer.from(args.changesBase64, "base64").toString("utf8"))
    : (args.changesJson ? JSON.parse(args.changesJson) : []);
  result = await completeInstallSnapshot(args.snapshot, changes);
} else if (command === "purge") {
  if (!args.snapshot) throw new Error("purge requires --snapshot");
  result = await purgeInstallSnapshot(args.snapshot);
} else {
  throw new Error("Usage: install_snapshot.js <create|restore|complete|purge> ...");
}

if (args.field) {
  const value = result[args.field];
  if (value === undefined) throw new Error(`Unknown result field: ${args.field}`);
  process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
} else {
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else { parsed[key] = next; index += 1; }
  }
  return parsed;
}
