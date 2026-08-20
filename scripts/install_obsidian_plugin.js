#!/usr/bin/env node
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const args = parseArgs(process.argv.slice(2));
if (!args.vault) throw new Error("--vault is required / 必须提供 --vault");

const root = path.resolve(args.root || process.cwd());
const vault = path.resolve(args.vault);
const pluginId = args.pluginId || "okf-obsidian-memory";
const source = path.join(root, "obsidian");
const obsidianDir = path.join(vault, ".obsidian");
const target = path.join(obsidianDir, "plugins", pluginId);

for (const required of [vault, source, path.join(source, "manifest.json"), path.join(source, "main.js")]) {
  if (!existsSync(required)) throw new Error(`Required path is missing / 缺少必要路径: ${required}`);
}

await mkdir(target, { recursive: true });
for (const file of ["manifest.json", "main.js", "styles.css"]) {
  const from = path.join(source, file);
  if (existsSync(from)) await copyFileAtomic(from, path.join(target, file));
}

const communityPlugins = path.join(obsidianDir, "community-plugins.json");
let enabled = [];
try {
  const value = JSON.parse(await readFile(communityPlugins, "utf8"));
  if (Array.isArray(value)) enabled = value.map(String);
} catch {
  // A missing file means this is the first community plugin installation.
}
if (!enabled.includes(pluginId)) enabled.push(pluginId);
await writeFileAtomic(communityPlugins, `${JSON.stringify(enabled, null, 2)}\n`);

console.log(JSON.stringify({ ok: true, vault, pluginId, target, enabled: true }, null, 2));

async function copyFileAtomic(from, to) {
  const temp = `${to}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(from, temp);
  await rename(temp, to);
}

async function writeFileAtomic(targetPath, content) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temp = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, targetPath);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else { result[key] = next; i += 1; }
  }
  return result;
}
