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
if (process.platform !== "win32") throw new Error("This validator must run on Windows / 此验证器必须在 Windows 上运行");
if (!args.vault || !existsSync(vault)) throw new Error("--vault must point to an existing Vault / --vault 必须指向已存在的 Vault");
if (!new Set(["pre-reboot", "post-reboot"]).has(phase)) throw new Error("--phase must be pre-reboot or post-reboot");

const artifactDir = path.join(root, "artifacts", "validation");
const preEvidencePath = path.join(artifactDir, "m5-windows-pre-reboot.json");
const evidencePath = path.join(artifactDir, `m5-windows-${phase}.json`);
const obsidian = args.obsidian || "D:\\Program Files\\Obsidian\\Obsidian.com";
const checks = [];
const bootId = await getBootId();

await capture("node_version", process.execPath, ["--version"], 10_000, { expect: /^v(?:2[5-9]|24\.(?:1[5-9]|[2-9]\d)\.)/m });
await capture("npm_version", "cmd.exe", ["/d", "/s", "/c", "npm --version"], 10_000);
await capture("bge_task", "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", taskStatusCommand("OKF Obsidian BGE-M3")], 20_000, { expect: /\"State\":\"Running\"/ });
await captureJson("embedding_health", process.execPath, [path.join(root, "scripts", "check_embedding_server.js")], 30_000, { jsonOk: true });
await capture("openclaw_gateway", "cmd.exe", ["/d", "/s", "/c", "openclaw gateway status"], 45_000, { expectAll: [/Runtime: running/, /Connectivity probe: ok/] });
await captureJson("setup_doctor", process.execPath, [path.join(root, "scripts", "setup_check.js"), "--vault", vault], 180_000, { jsonOk: true });
await captureJson("obsidian_cli", process.execPath, [path.join(root, "scripts", "verify_obsidian_cli.js"), "--obsidian", obsidian, "--vault", vault, "--timeout-ms", "20000"], 150_000, { jsonOk: true });
await captureJson("openclaw_plugin", process.execPath, [path.join(root, "scripts", "verify_plugin.js")], 60_000, { jsonOk: true });
await captureJson("openclaw_active_memory", process.execPath, [path.join(root, "scripts", "verify_openclaw_active_memory.js")], 300_000, { jsonOk: true });

let rebootObserved = null;
if (phase === "pre-reboot") {
  await capture("unit_tests", "cmd.exe", ["/d", "/s", "/c", "npm test"], 120_000);
  await capture("real_media_integration", "cmd.exe", ["/d", "/s", "/c", "npm run test:integration:media"], 900_000);
} else {
  const preEvidence = existsSync(preEvidencePath) ? JSON.parse(await readFile(preEvidencePath, "utf8")) : null;
  rebootObserved = Boolean(preEvidence?.bootId && preEvidence.bootId !== bootId);
  checks.push({
    name: "reboot_observed",
    ok: rebootObserved,
    detail: rebootObserved ? `boot time changed: ${preEvidence.bootId} -> ${bootId}` : "pre-reboot evidence is missing or boot time did not change",
    detailZh: rebootObserved ? `启动时间已变化：${preEvidence.bootId} -> ${bootId}` : "缺少重启前证据，或启动时间未变化"
  });
}

const failed = checks.filter((check) => !check.ok);
const evidence = {
  milestone: "M5",
  platform: "windows",
  phase,
  ok: failed.length === 0,
  generatedAt: new Date().toISOString(),
  hostname: os.hostname(),
  release: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
  root,
  vault,
  bootId,
  rebootObserved,
  checks,
  failed: failed.map((check) => check.name),
  next: phase === "pre-reboot"
    ? "Reboot Windows and run the post-reboot phase. / 重启 Windows 后运行 post-reboot 阶段。"
    : "Return both JSON evidence files to the main validation task. / 将两个 JSON 证据文件返回主验收任务。"
};
await atomicWriteJson(evidencePath, evidence);
console.log(JSON.stringify({ ok: evidence.ok, phase, evidencePath, failed: evidence.failed, next: evidence.next }, null, 2));
if (!evidence.ok) process.exitCode = 1;

async function getBootId() {
  const result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"], {
    cwd: root,
    timeoutMs: 20_000,
    stage: "M5 Windows boot time"
  });
  return result.stdout.trim();
}

function taskStatusCommand(name) {
  const escaped = name.replaceAll("'", "''");
  return `$task=Get-ScheduledTask -TaskName '${escaped}' -ErrorAction Stop; $info=Get-ScheduledTaskInfo -TaskName '${escaped}' -ErrorAction Stop; [pscustomobject]@{State=[string]$task.State;LastTaskResult=$info.LastTaskResult;LastRunTime=$info.LastRunTime.ToString('o')} | ConvertTo-Json -Compress`;
}

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
    const result = await runProcess(command, commandArgs, { cwd: root, timeoutMs, maxBuffer: 20 * 1024 * 1024, stage: `M5 Windows ${name}` });
    const output = `${result.stdout}\n${result.stderr}`;
    const matches = options.expectAll ? options.expectAll.every((pattern) => pattern.test(output)) : options.expect ? options.expect.test(output) : true;
    check = { name, ok: matches, durationMs: result.durationMs, stdout: trim(result.stdout), stderr: trim(result.stderr) };
    if (!check.ok) check.error = "Expected output was not found / 未找到预期输出";
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
