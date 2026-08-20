#!/usr/bin/env node
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root || process.cwd());
const vault = path.resolve(args.vault || path.join(root, "examples", "vault"));
const templatePath = path.resolve(args.template || path.join(root, "AGENT_HANDOFF.template.md"));
const outputPath = path.resolve(args.output || path.join(root, "AGENT_HANDOFF.md"));
const platform = args.platform || platformLabel();
const installState = await readInstallState(args.installState || path.join(root, ".okf-install", "last-install.json"));
const installMode = args.installMode || installState?.plan?.resolvedMode || "UNKNOWN";
const recoverySnapshot = args.recoverySnapshot || installState?.snapshotDir || "not recorded / 未记录";
const embedding = describeEmbedding(installMode, installState?.plan || {});

const template = await readFile(templatePath, "utf8");
const replacements = {
  "{{PLATFORM}}": safeInline(platform),
  "{{PROJECT_ROOT}}": safeInline(normalizeDisplayPath(root)),
  "{{VAULT_PATH}}": safeInline(normalizeDisplayPath(vault)),
  "{{GENERATED_AT}}": new Date().toISOString(),
  "{{INSTALL_MODE}}": safeInline(installMode),
  "{{EMBEDDING_DESCRIPTION}}": safeInline(embedding),
  "{{RECOVERY_SNAPSHOT}}": safeInline(normalizeDisplayPath(recoverySnapshot))
};

let rendered = template;
for (const [token, value] of Object.entries(replacements)) rendered = rendered.replaceAll(token, value);
const unresolved = rendered.match(/\{\{[A-Z0-9_]+\}\}/g) || [];
if (unresolved.length) throw new Error(`Unresolved Agent handoff tokens / Agent 告知文件仍有未替换字段: ${unresolved.join(", ")}`);

await atomicWrite(outputPath, rendered);
console.log(JSON.stringify({ ok: true, output: outputPath, root, vault, platform }, null, 2));

async function atomicWrite(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
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

function platformLabel() {
  if (process.platform === "win32") return `Windows ${os.release()}`;
  if (process.platform === "linux") return `Linux ${os.release()}`;
  return `${process.platform} ${os.release()}`;
}

function normalizeDisplayPath(value) {
  return process.platform === "win32" ? value : value.replaceAll("\\", "/");
}

function safeInline(value) {
  return String(value).replace(/[\r\n`]/g, " ").trim();
}

async function readInstallState(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")); }
  catch { return null; }
}

function describeEmbedding(mode, plan) {
  if (mode === "REUSE_EXISTING") return `复用目标 OpenClaw：${plan.existingProvider || "existing provider"} / ${plan.existingModel || "existing model"}`;
  if (mode === "SIDECAR") return "Sidecar：保留目标 OpenClaw 的既有向量配置，不部署或替换模型";
  if (mode === "ISOLATED") return "独立 CPU BGE-M3：OpenAI-compatible http://127.0.0.1:8008/v1";
  return "未记录；运行 openclaw memory status --json 核对";
}
