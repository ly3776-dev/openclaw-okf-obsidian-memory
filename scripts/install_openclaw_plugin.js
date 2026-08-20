#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../src/process.js";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root || process.cwd());
const pluginPath = path.resolve(args.pluginPath || args.path || "");
if (!pluginPath || !existsSync(path.join(pluginPath, "openclaw.plugin.json"))) {
  throw new Error("A prepared OpenClaw plugin path is required / 必须提供已准备好的 OpenClaw 插件目录。使用 --plugin-path <path>。");
}

const manifest = JSON.parse(await readFile(path.join(pluginPath, "openclaw.plugin.json"), "utf8"));
const localOpenClaw = path.join(root, "node_modules", "openclaw", "openclaw.mjs");
if (!existsSync(localOpenClaw)) throw new Error("Local OpenClaw CLI is missing; run npm install / 缺少本地 OpenClaw CLI，请先运行 npm install。");

await openclaw(["plugins", "install", pluginPath, "--link"], 60_000);
const configured = await readJsonCommand(["config", "get", "plugins.load.paths", "--json"], []);
const currentPaths = Array.isArray(configured) ? configured : [];
const kept = [];
const removed = [];
for (const configuredPath of currentPaths) {
  const resolved = path.resolve(String(configuredPath));
  if (samePath(resolved, pluginPath)) continue;
  if (await belongsToPlugin(resolved, manifest.id, root)) {
    removed.push(resolved);
    continue;
  }
  kept.push(configuredPath);
}
kept.push(pluginPath);

await openclaw(["config", "set", "plugins.load.paths", JSON.stringify(kept), "--strict-json"], 30_000);
await openclaw(["plugins", "registry", "--refresh", "--json"], 60_000);
const listed = await readJsonCommand(["plugins", "list", "--json"], {});
const plugins = Array.isArray(listed) ? listed : (Array.isArray(listed?.plugins) ? listed.plugins : []);
const loaded = plugins.find((item) => item.id === manifest.id);
if (!loaded || loaded.version !== manifest.version) {
  throw new Error(`OpenClaw plugin readback mismatch / OpenClaw 插件回读版本不一致: expected ${manifest.version}, got ${loaded?.version || "missing"}`);
}

console.log(JSON.stringify({
  ok: true,
  id: manifest.id,
  version: manifest.version,
  status: loaded.status,
  pluginPath,
  removedOldPaths: removed,
  preservedOtherPaths: kept.length - 1
}, null, 2));

async function belongsToPlugin(candidate, pluginId, projectRoot) {
  try {
    const candidateManifest = JSON.parse(await readFile(path.join(candidate, "openclaw.plugin.json"), "utf8"));
    if (candidateManifest.id === pluginId) return true;
  } catch {}
  const installRoot = path.join(projectRoot, ".okf-install");
  const relative = path.relative(installRoot, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) && /^openclaw-plugin-/i.test(relative.split(path.sep)[0]);
}

async function openclaw(commandArgs, timeoutMs) {
  return runProcess(process.execPath, [localOpenClaw, ...commandArgs], {
    cwd: root,
    timeoutMs,
    stage: `openclaw:${commandArgs.slice(0, 2).join(":")}`
  });
}

async function readJsonCommand(commandArgs, fallback) {
  try {
    const result = await openclaw(commandArgs, 30_000);
    return JSON.parse(result.stdout);
  } catch {
    return fallback;
  }
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
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
