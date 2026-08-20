#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const releaseName = `okf-obsidian-memory-${pkg.version}`;
const bundleDir = path.join(root, "release", releaseName);
const zipPath = path.join(root, "release", `${releaseName}.zip`);
const manifestPath = path.join(bundleDir, "release-manifest.json");

const requiredPaths = [
  "AGENT_HANDOFF.template.md",
  "INSTALL_WINDOWS.cmd",
  "install-linux.sh",
  "RELEASE_INSTALL.md",
  "release-manifest.json",
  "package.json",
  "package-lock.json",
  "openclaw.plugin.json",
  "src/cli.js",
  "src/core.js",
  "src/actionQueue.js",
  "src/obsidianViews.js",
  "src/sqliteIndex.js",
  "src/installPlan.js",
  "src/installSnapshot.js",
  "src/installSources.js",
  "plugin/native.js",
  "plugin/index.js",
  "skill/OKF_OBSIDIAN_MEMORY.md",
  "obsidian/main.js",
  "obsidian/manifest.json",
  "scripts/bootstrap_windows.ps1",
  "scripts/bootstrap_linux.sh",
  "scripts/easy_install_windows.ps1",
  "scripts/generate_agent_handoff.js",
  "scripts/validate_easy_installers.js",
  "scripts/start_bge_m3.ps1",
  "scripts/start_bge_m3.sh",
  "scripts/install_bge_service_windows.ps1",
  "scripts/install_bge_service_linux.sh",
  "scripts/run_bge_m3_supervisor.py",
  "scripts/prepare_bge_m3.py",
  "scripts/model_sources.py",
  "scripts/install_obsidian_plugin.js",
  "scripts/install_openclaw_plugin.js",
  "scripts/plan_openclaw_install.js",
  "scripts/install_snapshot.js",
  "scripts/resolve_install_sources.js",
  "scripts/prepare_openclaw_plugin.js",
  "scripts/validate_shell_syntax.js",
  "scripts/run_venv_python.js",
  "scripts/validate_m5_linux.js",
  "scripts/validate_m5_windows.js",
  "scripts/run_m5_windows_post_reboot.ps1",
  "scripts/m6_atomic_crash_child.js",
  "scripts/validate_m6_resilience.js",
  "scripts/security_check.js",
  "scripts/setup_check.js",
  "scripts/verify_bilingual_ui.js",
  "scripts/verify_all.js",
  "scripts/verify_obsidian_cli.js",
  "scripts/douyin_download.py",
  "scripts/douyin_browser_resolve.js",
  "docs/OPENCLAW_INSTALL.md",
  "docs/OBSIDIAN_SKILLS_INTEGRATION.md",
  "docs/RELEASE_CHECKLIST.md",
  "docs/LINUX_M5_VALIDATION.md",
  "docs/ROADMAP.md",
  "requirements-bge-m3.txt",
  "requirements.txt"
];

const forbiddenPaths = [
  "node_modules",
  "release",
  "examples/vault",
  "scripts/__pycache__",
  ".git"
];

const issues = [];
let manifest = null;

if (!existsSync(bundleDir)) issues.push(issue("missing_bundle", path.relative(root, bundleDir), "Release bundle directory is missing."));
if (!existsSync(zipPath)) issues.push(issue("missing_zip", path.relative(root, zipPath), "Release zip is missing."));

if (existsSync(bundleDir)) {
  manifest = await validateBundle(bundleDir, "bundle");
}

if (existsSync(zipPath)) {
  await validateZipArchive(zipPath);
}

const result = {
  ok: issues.length === 0,
  bundleDir,
  zipPath,
  files: manifest?.files?.length || 0,
  issues
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

async function validateBundle(currentBundleDir, context) {
  const currentManifestPath = path.join(currentBundleDir, "release-manifest.json");
  if (!existsSync(currentManifestPath)) {
    issues.push(issue("missing_manifest", displayPath(context, "release-manifest.json"), "Release manifest is missing."));
    return null;
  }

  const currentManifest = JSON.parse(await readFile(currentManifestPath, "utf8"));
  if (currentManifest.version !== pkg.version) {
    issues.push(issue("version_mismatch", displayPath(context, "release-manifest.json"), `Expected version ${pkg.version}.`));
  }

  for (const rel of requiredPaths) {
    if (!existsSync(path.join(currentBundleDir, rel))) {
      issues.push(issue("missing_required_path", displayPath(context, rel), "Required release file is missing."));
    }
  }

  for (const rel of forbiddenPaths) {
    if (existsSync(path.join(currentBundleDir, rel))) {
      issues.push(issue("forbidden_path", displayPath(context, rel), "Forbidden path is present in release bundle."));
    }
  }

  for (const file of currentManifest.files || []) {
    const absolute = path.join(currentBundleDir, file.path);
    if (!existsSync(absolute)) {
      issues.push(issue("manifest_file_missing", displayPath(context, file.path), "Manifest file entry is missing on disk."));
      continue;
    }
    const actual = await sha256(absolute);
    if (actual !== file.sha256) {
      issues.push(issue("manifest_hash_mismatch", displayPath(context, file.path), "Manifest sha256 does not match file content."));
    }
    const size = (await stat(absolute)).size;
    if (size !== file.bytes) {
      issues.push(issue("manifest_size_mismatch", displayPath(context, file.path), "Manifest size does not match file content."));
    }
  }

  const listedFiles = new Set((currentManifest.files || []).map((file) => file.path));
  const diskFiles = await listFiles(currentBundleDir);
  for (const rel of diskFiles) {
    if (rel === "release-manifest.json") continue;
    if (!listedFiles.has(rel)) {
      issues.push(issue("manifest_omits_file", displayPath(context, rel), "File is not listed in release manifest."));
    }
  }

  const scan = await execFileJson(process.execPath, [path.join(root, "scripts", "security_check.js"), "--root", currentBundleDir]);
  if (!scan.ok || scan.json?.ok !== true) {
    issues.push(issue("release_secret_scan_failed", displayPath(context, "release"), JSON.stringify(scan.json || scan.error || scan, null, 2).slice(0, 1000)));
  }

  return currentManifest;
}

async function validateZipArchive(currentZipPath) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "okf-release-zip-"));
  try {
    await extractZip(currentZipPath, tempRoot);
    const extractedBundleDir = await findExtractedBundleDir(tempRoot);
    if (!extractedBundleDir) {
      issues.push(issue("zip_missing_bundle_root", path.relative(root, currentZipPath), `Zip archive does not contain ${releaseName}.`));
      return;
    }
    await validateBundle(extractedBundleDir, "zip");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function extractZip(currentZipPath, destinationDir) {
  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${escapePowerShell(currentZipPath)}' -DestinationPath '${escapePowerShell(destinationDir)}' -Force`
    ], {
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 1024 * 1024
    });
    return;
  }
  await execFileAsync("unzip", ["-q", currentZipPath, "-d", destinationDir], {
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 1024 * 1024
  });
}

async function findExtractedBundleDir(tempRoot) {
  const expected = path.join(tempRoot, releaseName);
  if (existsSync(path.join(expected, "release-manifest.json"))) return expected;
  if (existsSync(path.join(tempRoot, "release-manifest.json"))) return tempRoot;
  for (const entry of await readdir(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(tempRoot, entry.name);
    if (existsSync(path.join(candidate, "release-manifest.json"))) return candidate;
  }
  return "";
}

async function listFiles(dir) {
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        result.push(rel);
      }
    }
  }
  await visit(dir);
  return result.sort((a, b) => a.localeCompare(b));
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function execFileJson(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: root,
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024
    });
    return { ok: true, json: JSON.parse(stdout) };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      stdout: error.stdout || "",
      stderr: error.stderr || ""
    };
  }
}

function issue(code, file, message) {
  return { code, file, message };
}

function displayPath(context, rel) {
  return context === "bundle" ? rel : `${context}:${rel}`;
}

function escapePowerShell(value) {
  return String(value).replaceAll("'", "''");
}
