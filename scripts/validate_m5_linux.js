#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson } from "../src/fsSafe.js";
import { runProcess } from "../src/process.js";

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const vault = path.resolve(args.vault || "");
const phase = args.phase || "pre-reboot";
if (process.platform !== "linux") throw new Error("This validator must run on real Linux / 此验证器必须在真实 Linux 上运行");
if (!args.vault || !existsSync(vault)) throw new Error("--vault must point to an existing Vault / --vault 必须指向已存在的 Vault");
if (!new Set(["pre-reboot", "post-reboot"]).has(phase)) throw new Error("--phase must be pre-reboot or post-reboot");

const artifactDir = path.join(root, "artifacts", "validation");
const preEvidencePath = path.join(artifactDir, "m5-linux-pre-reboot.json");
const evidencePath = path.join(artifactDir, `m5-linux-${phase}.json`);
const checks = [];
const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();

await capture("node_version", process.execPath, ["--version"], 10_000, { expect: /^v(?:2[5-9]|24\.(?:1[5-9]|[2-9]\d)\.)/m });
await capture("npm_version", "npm", ["--version"], 10_000);
await capture("systemd_enabled", "systemctl", ["--user", "is-enabled", "okf-bge-m3.service"], 15_000, { expect: /enabled/ });
await capture("systemd_active", "systemctl", ["--user", "is-active", "okf-bge-m3.service"], 15_000, { expect: /active/ });
await capture("systemd_state", "systemctl", ["--user", "show", "okf-bge-m3.service", "--property=ActiveState,SubState,MainPID,ExecMainStartTimestamp,ExecMainStartTimestampMonotonic"], 15_000);
await captureJson("embedding_health", process.execPath, [path.join(root, "scripts", "check_embedding_server.js")], 30_000);
await captureJson("setup_doctor", process.execPath, [path.join(root, "scripts", "setup_check.js"), "--vault", vault], 120_000, { jsonOk: true });
await captureJson("obsidian_cli", process.execPath, [path.join(root, "scripts", "verify_obsidian_cli.js"), "--vault", vault, "--timeout-ms", "15000"], 120_000, { jsonOk: true });
await captureJson("openclaw_plugin", process.execPath, [path.join(root, "scripts", "verify_plugin.js")], 60_000, { jsonOk: true });
await captureJson("openclaw_active_memory", process.execPath, [path.join(root, "scripts", "verify_openclaw_active_memory.js")], 240_000, { jsonOk: true });

let rebootObserved = null;
let preEvidence = null;
if (phase === "pre-reboot") {
  await capture("unit_tests", "npm", ["test"], 120_000);
  await capture("real_media_integration", "npm", ["run", "test:integration:media"], 900_000);
  await captureJson("shell_syntax", process.execPath, [path.join(root, "scripts", "validate_shell_syntax.js")], 60_000, { jsonOk: true });
} else {
  if (existsSync(preEvidencePath)) preEvidence = JSON.parse(await readFile(preEvidencePath, "utf8"));
  rebootObserved = Boolean(preEvidence?.bootId && preEvidence.bootId !== bootId);
  checks.push({
    name: "reboot_observed",
    ok: rebootObserved,
    detail: rebootObserved ? `boot id changed: ${preEvidence.bootId} -> ${bootId}` : "pre-reboot evidence is missing or boot id did not change",
    detailZh: rebootObserved ? `启动 ID 已变化：${preEvidence.bootId} -> ${bootId}` : "缺少重启前证据，或启动 ID 未变化"
  });
}

const failed = checks.filter((check) => !check.ok);
const evidence = {
  milestone: "M5",
  platform: "linux",
  phase,
  ok: failed.length === 0,
  generatedAt: new Date().toISOString(),
  hostname: os.hostname(),
  release: (JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))).version,
  root,
  vault,
  bootId,
  rebootObserved,
  checks,
  failed: failed.map((check) => check.name),
  next: phase === "pre-reboot"
    ? "Reboot Linux, start Obsidian and OpenClaw if their desktop/session startup requires it, then run the post-reboot phase. / 重启 Linux，按需启动 Obsidian 与 OpenClaw，然后运行 post-reboot 阶段。"
    : "Return both JSON evidence files to the main validation task. / 将两个 JSON 证据文件返回主验收任务。"
};
await atomicWriteJson(evidencePath, evidence);
console.log(JSON.stringify({ ok: evidence.ok, phase, evidencePath, failed: evidence.failed, next: evidence.next }, null, 2));
if (!evidence.ok) process.exitCode = 1;

async function captureJson(name, command, commandArgs, timeoutMs, options = {}) {
  const check = await capture(name, command, commandArgs, timeoutMs, { ...options, deferPush: true });
  try { check.json = JSON.parse(check.stdout); }
  catch { check.ok = false; check.error = `${check.error || ""} Invalid JSON output / JSON 输出无效`.trim(); }
  if (options.jsonOk && check.json?.ok !== true) {
    check.ok = false;
    check.error = `${check.error || ""} JSON result did not report ok=true / JSON 结果未报告 ok=true`.trim();
  }
  checks.push(check);
  return check;
}

async function capture(name, command, commandArgs, timeoutMs, options = {}) {
  const started = Date.now();
  let check;
  try {
    const result = await runProcess(command, commandArgs, { cwd: root, timeoutMs, maxBuffer: 20 * 1024 * 1024, stage: `M5 Linux ${name}` });
    const output = `${result.stdout}\n${result.stderr}`;
    check = { name, ok: options.expect ? options.expect.test(output) : true, durationMs: result.durationMs, stdout: trim(result.stdout), stderr: trim(result.stderr) };
    if (!check.ok) check.error = `Expected output was not found / 未找到预期输出: ${options.expect}`;
  } catch (error) {
    check = { name, ok: false, durationMs: Date.now() - started, error: error.message, stdout: trim(error.stdout), stderr: trim(error.stderr) };
  }
  if (!options.deferPush) checks.push(check);
  return check;
}

function trim(value, max = 20_000) { const text = String(value || "").trim(); return text.length > max ? `${text.slice(0, max)}...` : text; }
function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else { parsed[key] = next; i += 1; }
  }
  return parsed;
}
