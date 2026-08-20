#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveInstallPlan } from "../src/installPlan.js";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const openclaw = await resolveOpenClawBin(args.openclaw, root);
const configPath = path.resolve(args.config || path.join(os.homedir(), ".openclaw", "openclaw.json"));

let observed;
if (args.mockState) {
  observed = JSON.parse(await readFile(path.resolve(args.mockState), "utf8"));
} else {
  const memorySearch = await readJsonCommand(openclaw, ["config", "get", "agents.defaults.memorySearch", "--json"], {});
  const memoryStatuses = await readJsonCommand(openclaw, ["memory", "status", "--json"], []);
  const gatewayStatus = await readJsonCommand(openclaw, ["gateway", "status", "--json", "--no-probe"], {});
  const semanticConfigured = memorySearch?.provider && memorySearch.provider !== "none";
  const vectorEnabled = Array.isArray(memoryStatuses) && memoryStatuses.some((entry) => entry?.status?.vector?.enabled === true);
  const embeddingProbeOk = semanticConfigured && vectorEnabled
    ? await commandOk(openclaw, ["memory", "search", "--query", "okf installer read only probe", "--max-results", "1", "--json"], 45_000)
    : false;
  observed = {
    configExists: existsSync(configPath),
    memorySearch,
    memoryStatuses,
    embeddingProbeOk,
    gatewayStatus
  };
}

const plan = resolveInstallPlan({
  ...observed,
  requestedMode: args.mode || "AUTO",
  allowProviderReplace: Boolean(args.allowProviderReplace)
});
const result = { ok: true, openclaw, configPath, ...plan };
if (args.field) {
  if (!Object.hasOwn(result, args.field)) throw new Error(`Unknown plan field: ${args.field}`);
  process.stdout.write(String(result[args.field]));
} else {
  console.log(JSON.stringify(result, null, 2));
}

async function resolveOpenClawBin(value, projectRoot) {
  if (value) return path.resolve(value);
  const local = path.join(projectRoot, "node_modules", "openclaw", "openclaw.mjs");
  return existsSync(local) ? local : "openclaw";
}

async function readJsonCommand(openclawBin, commandArgs, fallback) {
  try {
    const result = await runOpenClaw(openclawBin, commandArgs, 45_000);
    return JSON.parse(result.stdout);
  } catch {
    return fallback;
  }
}

async function commandOk(openclawBin, commandArgs, timeout) {
  try {
    await runOpenClaw(openclawBin, commandArgs, timeout);
    return true;
  } catch {
    return false;
  }
}

function runOpenClaw(openclawBin, commandArgs, timeout) {
  const isMjs = /\.mjs$/i.test(openclawBin);
  return execFileAsync(isMjs ? process.execPath : openclawBin, isMjs ? [openclawBin, ...commandArgs] : commandArgs, {
    cwd: root,
    windowsHide: true,
    timeout,
    maxBuffer: 20 * 1024 * 1024
  });
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
