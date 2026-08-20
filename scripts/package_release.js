#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const releaseName = `okf-obsidian-memory-${pkg.version}`;
const releaseRoot = path.join(root, "release");
const bundleDir = path.join(releaseRoot, releaseName);
const zipPath = path.join(releaseRoot, `${releaseName}.zip`);

const fileAllowlist = [
  ".env.example",
  "AGENT_HANDOFF.template.md",
  "INSTALL_WINDOWS.cmd",
  "install-linux.sh",
  "openclaw.plugin.json",
  "package-lock.json",
  "package.json",
  "README.md",
  "requirements-bge-m3.txt",
  "requirements.txt"
];

const directoryAllowlist = [
  "docs",
  "obsidian",
  "plugin",
  "scripts",
  "skill",
  "src",
  "test"
];

const exampleFiles = [
  "examples/sample-data.json",
  "examples/sample-image.png",
  "examples/sample-input.md",
  "examples/sample-pdf.pdf"
];

const skipDirs = new Set([
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
  "node_modules",
  "release"
]);

const skipExtensions = new Set([
  ".pyc",
  ".zip",
  ".gz",
  ".7z"
]);

await rm(bundleDir, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(bundleDir, { recursive: true });

for (const rel of fileAllowlist) await copyPath(rel);
for (const rel of directoryAllowlist) await copyPath(rel);
for (const rel of exampleFiles) await copyPath(rel);

await writeFile(path.join(bundleDir, "RELEASE_INSTALL.md"), renderReleaseInstall(pkg), "utf8");

const files = await listFiles(bundleDir);
const manifest = {
  name: pkg.name,
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  sourceRoot: root,
  bundleDir,
  zipPath,
  installDocs: "RELEASE_INSTALL.md",
  excludes: [
    "node_modules",
    "release",
    "examples/vault",
    ".okf-cache",
    "okf-export",
    "__pycache__",
    "local secrets and machine config"
  ],
  files: []
};

for (const rel of files) {
  const absolute = path.join(bundleDir, rel);
  manifest.files.push({
    path: rel,
    bytes: (await stat(absolute)).size,
    sha256: await sha256(absolute)
  });
}

await writeFile(path.join(bundleDir, "release-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
await createZip(bundleDir, zipPath);

console.log(JSON.stringify({
  ok: true,
  bundleDir,
  zipPath,
  files: manifest.files.length + 1
}, null, 2));

async function copyPath(rel) {
  const from = path.join(root, rel);
  const to = path.join(bundleDir, rel);
  const info = await stat(from);
  if (info.isDirectory()) {
    await copyDirectory(from, to);
  } else if (info.isFile()) {
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

async function copyDirectory(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(source, target);
    } else if (entry.isFile() && !skipExtensions.has(path.extname(entry.name).toLowerCase())) {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
}

async function listFiles(dir) {
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && rel !== "release-manifest.json") {
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

async function createZip(sourceDir, targetZip) {
  if (process.platform === "win32") {
    const command = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      `Compress-Archive -LiteralPath '${escapePowerShell(sourceDir)}' -DestinationPath '${escapePowerShell(targetZip)}' -Force`
    ];
    await execFileAsync("powershell.exe", command, { windowsHide: true, maxBuffer: 1024 * 1024 });
    return;
  }
  await execFileAsync("zip", ["-qr", targetZip, path.basename(sourceDir)], {
    cwd: path.dirname(sourceDir),
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
}

function escapePowerShell(value) {
  return String(value).replaceAll("'", "''");
}

function renderReleaseInstall(packageJson) {
  return [
    "# OKF Obsidian Memory Release Install",
    "",
    `Version: ${packageJson.version}`,
    "",
    "## Install / 安装",
    "",
    "Windows easy install (recommended):",
    "",
    "1. Extract the ZIP.",
    "2. Double-click `INSTALL_WINDOWS.cmd`.",
    "3. Select the Obsidian Vault folder and wait for the completion dialog.",
    "4. Copy the generated `AGENT_HANDOFF.md` to the Agent.",
    "",
    "Windows 简易安装：解压后双击 `INSTALL_WINDOWS.cmd`，选择 Vault，等待完成；最后只需把生成的 `AGENT_HANDOFF.md` 交给 Agent。",
    "",
    "Linux easy install (recommended):",
    "",
    "```bash",
    "bash ./install-linux.sh",
    "```",
    "",
    "The Linux launcher uses a graphical folder picker when `zenity` is available; otherwise it asks once for the Vault path. It generates the same single `AGENT_HANDOFF.md` file.",
    "",
    "Linux 安装入口在有 `zenity` 时会弹出目录选择器，否则只询问一次 Vault 路径；安装后同样只需交给 Agent 一个 `AGENT_HANDOFF.md`。",
    "",
    "Prerequisites / 前置条件:",
    "",
    "- Windows can install missing Node.js 24 LTS, Python 3.12, and FFmpeg automatically through winget.",
    "- Linux requires Node.js >=24.15.0, Python 3.9-3.13, sudo/package-manager access for FFmpeg, and a systemd user session.",
    "- Obsidian can be installed before or after; the plugin files are placed in the selected Vault.",
    "- The default CN download profile uses npmmirror, Tsinghua PyPI, ModelScope, and hf-mirror compatibility. Use `-NetworkProfile GLOBAL` / `--network-profile GLOBAL` only when official overseas endpoints are reachable.",
    "- 安装器默认使用国内下载源：npmmirror、清华 PyPI、ModelScope 和 hf-mirror 兼容端点。境外源可达时才切换 GLOBAL。",
    "",
    "Advanced unattended install:",
    "",
    "```powershell",
    "powershell -ExecutionPolicy Bypass -File .\\scripts\\bootstrap_windows.ps1 -Vault <Vault> -InstallMode AUTO -InstallService -NetworkProfile CN",
    "```",
    "",
    "Manual plugin fallback:",
    "",
    "```powershell",
    "$pluginPath = node .\\scripts\\prepare_openclaw_plugin.js --print-path",
    "openclaw plugins install $pluginPath --link",
    "```",
    "",
    "The bootstrap installs and enables the Obsidian companion plugin automatically. Manual fallback:",
    "",
    "```text",
    "obsidian/ -> <Vault>/.obsidian/plugins/okf-obsidian-memory/",
    "```",
    "",
    "安装脚本会自动安装并启用 Obsidian 插件。手工回退方式：",
    "",
    "```text",
    "obsidian/ -> <Vault>/.obsidian/plugins/okf-obsidian-memory/",
    "```",
    "",
    "## Configure / 配置",
    "",
    "Do not commit or share API keys. Put local values in environment variables or Obsidian plugin settings.",
    "",
    "不要提交或分享 API key。把本机配置放到环境变量或 Obsidian 插件设置里。",
    "The easy installer already configures local BGE-M3, the OpenClaw plugin, Gateway, Active Memory, and the selected Vault.",
    "简易安装器已经自动配置本地 BGE-M3、OpenClaw 插件、Gateway、Active Memory 和所选 Vault。",
    "",
    "```powershell",
    "$env:OKF_LLM_BASE_URL=\"http://your-openai-compatible-gateway/\"",
    "$env:OKF_LLM_API_KEY=\"sk-...\"",
    "$env:OKF_LLM_MODEL=\"your-chat-model\"",
    "$env:OKF_TAVILY_API_KEY=\"tvly-...\"",
    "$env:OKF_EMBEDDING_BASE_URL=\"http://127.0.0.1:8008/v1\"",
    "$env:OKF_EMBEDDING_API_KEY=\"okf-local\"",
    "$env:OKF_EMBEDDING_MODEL=\"BAAI/bge-m3\"",
    "```",
    "",
    "Start local BGE-M3 when the target machine does not already provide an embedding endpoint:",
    "",
    "```powershell",
    "powershell -ExecutionPolicy Bypass -File .\\scripts\\install_bge_service_windows.ps1",
    "npm run embedding:health",
    "```",
    "",
    "## Verify / 验证",
    "",
    "```powershell",
    "npm run setup:check",
    "npm run security:check",
    "npm run verify:plugin",
    "npm run verify:obsidian",
    "npm run verify:obsidian-cli",
    "npm run ui:bilingual",
    "npm run obsidian:views",
    "npm run sqlite:index",
    "npm run ontology:validate",
    "npm run actions:validate",
    "npm run okf:validate",
    "npm run okf:export",
    "```",
    "",
    "With BGE-M3 and OpenClaw running, use the full closed loop:",
    "",
    "```powershell",
    "npm run verify:all",
    "```",
    "",
    "如果目标机器还没有 BGE-M3 或 OpenClaw Gateway，可以先跑离线验证：",
    "",
    "```powershell",
    "npm run verify:all -- --skip-embedding --skip-openclaw",
    "```",
    "",
    "Before moving to production, follow `docs/RELEASE_CHECKLIST.md`.",
    "",
    "正式迁移前，按 `docs/RELEASE_CHECKLIST.md` 检查。",
    "",
    "## Contents / 内容",
    "",
    "- OpenClaw native plugin: `plugin/native.js`",
    "- OpenClaw skill instructions: `skill/OKF_OBSIDIAN_MEMORY.md`",
    "- Obsidian companion plugin: `obsidian/`",
    "- CLI and core memory system: `src/`",
    "- OCR/transcription/Douyin/BGE/bootstrap helpers: `scripts/`",
    "- Documentation: `docs/`",
    "",
    "Excluded by design: `node_modules`, local caches, `examples/vault`, generated media, OpenClaw local config, and secrets.",
    "",
    "默认排除：`node_modules`、本地缓存、`examples/vault`、生成媒体、OpenClaw 本机配置和密钥。",
    ""
  ].join("\n");
}
