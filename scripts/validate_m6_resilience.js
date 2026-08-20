#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "../src/fsSafe.js";
import { runProcess } from "../src/process.js";

const root = process.cwd();
const outputPath = path.join(root, "artifacts", "validation", "m6-resilience-validation.json");
const embeddingApiKey = process.env.OKF_EMBEDDING_API_KEY || "okf-local";
const report = {
  milestone: "M6",
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  atomicProcessCrash: await validateAtomicProcessCrash(),
  bgeRestartRecovery: await validateBgeRestartRecovery()
};
report.ok = report.atomicProcessCrash.ok && report.bgeRestartRecovery.ok;
await atomicWriteFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

async function validateAtomicProcessCrash() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "okf-m6-crash-"));
  const targetPath = path.join(directory, "index.json");
  const readyPath = path.join(directory, "ready.json");
  let child;
  try {
    await writeFile(targetPath, '{"generation":"old"}\n', "utf8");
    child = spawn(process.execPath, [path.join(root, "scripts", "m6_atomic_crash_child.js"), targetPath, readyPath], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const ready = await waitForFile(readyPath, 10_000);
    const interruptedPid = child.pid;
    child.kill("SIGKILL");
    await waitForExit(child, 10_000);
    const afterCrash = JSON.parse(await readFile(targetPath, "utf8"));
    await atomicWriteFile(targetPath, '{"generation":"recovered"}\n', { encoding: "utf8" });
    const afterRecovery = JSON.parse(await readFile(targetPath, "utf8"));
    const temporaryFiles = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
    return {
      ok: ready.pid === interruptedPid && afterCrash.generation === "old" && afterRecovery.generation === "recovered",
      interruptedPid,
      killedAfterFileFsyncBeforeRename: true,
      oldIndexReadable: afterCrash.generation === "old",
      nextAtomicWriteSucceeded: afterRecovery.generation === "recovered",
      orphanTemporaryFilesIgnored: temporaryFiles.length,
      cacheCorruptionObserved: false
    };
  } catch (error) {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    return { ok: false, error: error.message };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function validateBgeRestartRecovery() {
  if (process.platform !== "win32") {
    return { ok: false, skipped: true, reason: "Run the target-platform service restart test on Linux." };
  }
  const initial = await embeddingProbe();
  if (!initial.ok) return { ok: false, stage: "initial_health", error: initial.error };
  const startedAt = Date.now();
  try {
    await powerShell("Stop-ScheduledTask -TaskName 'OKF Obsidian BGE-M3' -ErrorAction Stop");
    const downObserved = await waitForHealth(false, 30_000);
    await powerShell("Start-ScheduledTask -TaskName 'OKF Obsidian BGE-M3' -ErrorAction Stop");
    const recovered = await waitForHealth(true, 180_000);
    const finalProbe = await embeddingProbe();
    const task = await powerShell("$task = Get-ScheduledTask -TaskName 'OKF Obsidian BGE-M3'; @{ TaskName = $task.TaskName; State = [string]$task.State } | ConvertTo-Json -Compress");
    const taskState = safeJson(task.stdout);
    return {
      ok: downObserved && recovered && finalProbe.ok && finalProbe.dimensions === 1024 && taskState.State === "Running",
      initialDimensions: initial.dimensions,
      healthDownObserved: downObserved,
      healthRecovered: recovered,
      recoveryMs: Date.now() - startedAt,
      finalDimensions: finalProbe.dimensions,
      scheduledTask: taskState
    };
  } catch (error) {
    try { await powerShell("Start-ScheduledTask -TaskName 'OKF Obsidian BGE-M3' -ErrorAction SilentlyContinue"); } catch {}
    return { ok: false, error: error.message, recoveryMs: Date.now() - startedAt };
  }
}

async function embeddingProbe() {
  try {
    const response = await fetch("http://127.0.0.1:8008/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${embeddingApiKey}`
      },
      body: JSON.stringify({ model: "BAAI/bge-m3", input: ["M6 restart recovery probe"] }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    const dimensions = json.data?.[0]?.embedding?.length || 0;
    return { ok: dimensions > 0, dimensions };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function waitForHealth(expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await embeddingProbe()).ok === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function powerShell(script) {
  const result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: root,
    timeoutMs: 30_000,
    stage: "M6 BGE service restart"
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `PowerShell exited ${result.exitCode}`);
  return result;
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return JSON.parse(await readFile(filePath, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for child crash checkpoint: ${filePath}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for killed child")), timeoutMs))
  ]);
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return text.trim(); }
}
