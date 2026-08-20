import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

export async function createInstallSnapshot({ root, vault, openclawConfig, plan = {}, snapshotRoot }) {
  const resolvedSnapshotRoot = path.resolve(snapshotRoot || privateSnapshotRoot());
  const snapshotDir = path.join(resolvedSnapshotRoot, `${timestamp()}-${randomUUID().slice(0, 8)}`);
  await mkdir(snapshotDir, { recursive: true });
  const targets = snapshotTargets({ vault, openclawConfig });
  const entries = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const originalExists = existsSync(target.path);
    let type = "missing";
    let backup = null;
    if (originalExists) {
      const info = await stat(target.path);
      type = info.isDirectory() ? "directory" : "file";
      backup = path.join("backup", String(index));
      const destination = path.join(snapshotDir, backup);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(target.path, destination, { recursive: true, force: false, errorOnExist: true });
    }
    entries.push({ id: target.id, path: target.path, originalExists, type, backup });
  }
  const manifest = {
    snapshotVersion: "1",
    createdAt: new Date().toISOString(),
    status: "prepared",
    root: path.resolve(root),
    vault: path.resolve(vault),
    openclawConfig: path.resolve(openclawConfig || path.join(os.homedir(), ".openclaw", "openclaw.json")),
    plan,
    entries,
    exclusions: ["derived OpenClaw memory indexes", "Vault .okf-cache", "Vault okf-export"]
  };
  await writeManifest(snapshotDir, manifest);
  await hardenSnapshot(snapshotDir);
  return { snapshotDir, manifest };
}

export async function restoreInstallSnapshot(snapshotDir) {
  const manifest = await readManifest(snapshotDir);
  for (const entry of [...manifest.entries].reverse()) {
    if (entry.originalExists) {
      await rm(entry.path, { recursive: true, force: true });
      await mkdir(path.dirname(entry.path), { recursive: true });
      await cp(path.join(snapshotDir, entry.backup), entry.path, { recursive: entry.type === "directory", force: false, errorOnExist: true });
    } else {
      await rm(entry.path, { recursive: true, force: true });
    }
  }
  manifest.status = "restored";
  manifest.restoredAt = new Date().toISOString();
  await rm(path.join(snapshotDir, "backup"), { recursive: true, force: true });
  manifest.backupsPurgedAt = new Date().toISOString();
  await writeManifest(snapshotDir, manifest);
  await hardenSnapshot(snapshotDir);
  return manifest;
}

export async function completeInstallSnapshot(snapshotDir, changes = []) {
  const manifest = await readManifest(snapshotDir);
  manifest.status = "completed";
  manifest.completedAt = new Date().toISOString();
  manifest.appliedChanges = changes;
  await writeManifest(snapshotDir, manifest);
  const installState = {
    version: "1",
    completedAt: manifest.completedAt,
    snapshotDir: path.resolve(snapshotDir),
    root: manifest.root,
    vault: manifest.vault,
    plan: manifest.plan,
    appliedChanges: changes
  };
  await atomicWriteJson(path.join(manifest.root, ".okf-install", "last-install.json"), installState);
  await hardenSnapshot(snapshotDir);
  return manifest;
}

export async function purgeInstallSnapshot(snapshotDir) {
  const resolved = path.resolve(snapshotDir);
  const allowedRoot = path.resolve(privateSnapshotRoot());
  const legacyRoot = path.resolve(process.cwd(), ".okf-install", "snapshots");
  if (!isWithin(resolved, allowedRoot) && !isWithin(resolved, legacyRoot)) {
    throw new Error(`Refusing to purge snapshot outside an approved snapshot root: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
  return { purged: resolved, exists: existsSync(resolved) };
}

function snapshotTargets({ vault, openclawConfig }) {
  const vaultPath = path.resolve(vault);
  return [
    { id: "openclaw_config", path: path.resolve(openclawConfig || path.join(os.homedir(), ".openclaw", "openclaw.json")) },
    { id: "obsidian_community_plugins", path: path.join(vaultPath, ".obsidian", "community-plugins.json") },
    { id: "obsidian_okf_plugin", path: path.join(vaultPath, ".obsidian", "plugins", "okf-obsidian-memory") },
    { id: "okf_vault_config", path: path.join(vaultPath, "okf-obsidian.config.json") }
  ];
}

async function readManifest(snapshotDir) {
  return JSON.parse(await readFile(path.join(path.resolve(snapshotDir), "snapshot.json"), "utf8"));
}

async function writeManifest(snapshotDir, manifest) {
  await atomicWriteJson(path.join(path.resolve(snapshotDir), "snapshot.json"), manifest);
}

async function atomicWriteJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function privateSnapshotRoot() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OKF Obsidian Memory", "install-snapshots");
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "okf-obsidian-memory", "install-snapshots");
}

async function hardenSnapshot(snapshotDir) {
  if (process.platform === "win32") {
    const account = await new Promise((resolve, reject) => {
      execFile("whoami.exe", [], { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    });
    await new Promise((resolve, reject) => {
      execFile("icacls.exe", [snapshotDir, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`], { windowsHide: true }, (error) => error ? reject(error) : resolve());
    });
    return;
  }
  await chmod(snapshotDir, 0o700);
  await chmodTree(path.join(snapshotDir, "backup"));
  await chmod(path.join(snapshotDir, "snapshot.json"), 0o600).catch(() => {});
}

async function chmodTree(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return; }
  await chmod(directory, 0o700);
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await chmodTree(target);
    else if (entry.isFile()) await chmod(target, 0o600);
  }
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
