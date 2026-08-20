import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";

export const DEFAULT_LOCK_OPTIONS = Object.freeze({
  timeoutMs: 60_000,
  staleMs: 300_000,
  retryMinMs: 25,
  retryMaxMs: 75
});

export async function atomicWriteFile(targetPath, data, options = {}) {
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, "wx", options.mode);
    await handle.writeFile(data, options.encoding || (typeof data === "string" ? "utf8" : undefined));
    await handle.sync();
    await handle.close();
    handle = null;
    if (options.beforeRename) await options.beforeRename(tempPath, targetPath);
    await rename(tempPath, targetPath);
    await syncDirectory(directory);
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await unlink(tempPath); } catch {}
    throw error;
  }
}

export async function atomicWriteJson(targetPath, value, options = {}) {
  return atomicWriteFile(targetPath, `${JSON.stringify(value, null, options.space ?? 2)}\n`, { ...options, encoding: "utf8" });
}

export async function withFileLock(lockPath, work, options = {}) {
  const settings = lockSettings(options);
  const token = crypto.randomUUID();
  const startedAt = Date.now();
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      await writeLockOwner(lockPath, token);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await recoverStaleLock(lockPath, settings.staleMs)) continue;
      if (Date.now() - startedAt >= settings.timeoutMs) {
        const lockError = new Error(`Timed out waiting ${settings.timeoutMs}ms for write lock ${lockPath}. / 等待写锁 ${lockPath} 超过 ${settings.timeoutMs}ms。`);
        lockError.code = "LOCK_TIMEOUT";
        lockError.lockPath = lockPath;
        throw lockError;
      }
      await delay(randomInteger(settings.retryMinMs, settings.retryMaxMs));
    }
  }

  try {
    return await work();
  } finally {
    await releaseOwnedLock(lockPath, token);
  }
}

export function vaultWriteLockPath(vault, config) {
  return path.join(vault, config?.cacheDir || ".okf-cache", "write.lock");
}

async function writeLockOwner(lockPath, token) {
  const owner = {
    token,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString()
  };
  const handle = await open(path.join(lockPath, "owner.json"), "wx");
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function recoverStaleLock(lockPath, staleMs) {
  let owner = null;
  let ageMs = 0;
  try {
    const [raw, details] = await Promise.all([
      readFile(path.join(lockPath, "owner.json"), "utf8").catch(() => ""),
      stat(lockPath)
    ]);
    owner = raw ? JSON.parse(raw) : null;
    ageMs = Date.now() - details.mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
  if (ageMs < staleMs) return false;
  if (owner?.hostname === os.hostname() && isProcessAlive(owner.pid)) return false;
  try {
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function releaseOwnedLock(lockPath, token) {
  try {
    const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    if (owner.token !== token) return;
    await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Some filesystems do not support directory fsync.
  } finally {
    try { await handle?.close(); } catch {}
  }
}

function lockSettings(options) {
  return {
    timeoutMs: positiveInteger(options.timeoutMs ?? process.env.OKF_LOCK_TIMEOUT_MS, DEFAULT_LOCK_OPTIONS.timeoutMs),
    staleMs: positiveInteger(options.staleMs ?? process.env.OKF_LOCK_STALE_MS, DEFAULT_LOCK_OPTIONS.staleMs),
    retryMinMs: positiveInteger(options.retryMinMs, DEFAULT_LOCK_OPTIONS.retryMinMs),
    retryMaxMs: positiveInteger(options.retryMaxMs, DEFAULT_LOCK_OPTIONS.retryMaxMs)
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function randomInteger(min, max) {
  return Math.floor(Math.random() * (Math.max(min, max) - min + 1)) + min;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
