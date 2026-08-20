#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../src/process.js";
import { resolveInstallSources } from "../src/installSources.js";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const vault = path.resolve(args.vault || path.join(root, "examples", "vault"));
const checks = [];

await checkPackage();
await checkNode();
await checkFiles();
await checkInstallSources();
await checkNpm();
await checkPython();
await checkFfmpeg();
await checkExtractor();
await checkEmbedding();
await checkService();
await checkObsidian();
await checkOpenClaw();

const requiredFailures = checks.filter((check) => check.required && check.status !== "ok");
const result = {
  ok: requiredFailures.length === 0,
  root,
  vault,
  summary: { en: `${checks.filter((item) => item.status === "ok").length}/${checks.length} checks OK`, zh: `${checks.length} 项中 ${checks.filter((item) => item.status === "ok").length} 项正常` },
  checks,
  requiredFailures: requiredFailures.map((check) => check.id)
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

async function checkPackage() {
  let pkg = null;
  try { pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); } catch {}
  add("package", "Project package", "项目包", pkg ? "ok" : "fail", true,
    pkg ? `${pkg.name}@${pkg.version}` : "package.json is missing", pkg ? `${pkg.name}@${pkg.version}` : "缺少 package.json",
    "Restore package.json from the release archive", "从发布包恢复 package.json");
}

async function checkNode() {
  const [major, minor, patchVersion] = process.versions.node.split(".").map(Number);
  const supported = major > 24 || (major === 24 && (minor > 15 || (minor === 15 && patchVersion >= 0)));
  add("node24", "Node.js >=24.15.0 LTS", "Node.js >=24.15.0 LTS", supported ? "ok" : "fail", true, process.version, process.version,
    "Install Node.js >=24.15.0 LTS and rerun npm install", "安装 Node.js >=24.15.0 LTS，然后重新运行 npm install");
  try {
    const sqlite = await import("node:sqlite");
    add("node_sqlite", "SQLite cache", "SQLite 缓存", sqlite.DatabaseSync ? "ok" : "fail", true,
      "node:sqlite DatabaseSync is available", "node:sqlite DatabaseSync 可用",
      "Install the latest Node.js 24 LTS", "安装最新 Node.js 24 LTS");
  } catch (error) {
    add("node_sqlite", "SQLite cache", "SQLite 缓存", "fail", true, error.message, error.message,
      "Install the latest Node.js 24 LTS", "安装最新 Node.js 24 LTS");
  }
}

async function checkFiles() {
  for (const rel of [
    "AGENT_HANDOFF.template.md", "INSTALL_WINDOWS.cmd", "install-linux.sh",
    "src/cli.js", "src/sqliteIndex.js", "src/installPlan.js", "src/installSnapshot.js", "src/installSources.js", "plugin/native.js", "obsidian/main.js", "obsidian/manifest.json",
    "requirements.txt", "requirements-bge-m3.txt", "scripts/bootstrap_windows.ps1", "scripts/bootstrap_linux.sh",
    "scripts/easy_install_windows.ps1", "scripts/generate_agent_handoff.js", "scripts/validate_easy_installers.js", "scripts/plan_openclaw_install.js", "scripts/install_snapshot.js", "scripts/resolve_install_sources.js",
    "scripts/install_bge_service_windows.ps1", "scripts/install_bge_service_linux.sh", "scripts/run_bge_m3_supervisor.py",
    "scripts/prepare_bge_m3.py", "scripts/model_sources.py", "scripts/install_obsidian_plugin.js", "scripts/install_openclaw_plugin.js", "scripts/prepare_openclaw_plugin.js", "scripts/run_venv_python.js",
    "scripts/validate_m5_linux.js", "scripts/validate_m5_windows.js", "scripts/run_m5_windows_post_reboot.ps1",
    "scripts/m6_atomic_crash_child.js", "scripts/validate_m6_resilience.js",
    "docs/LINUX_M5_VALIDATION.md"
  ]) {
    const present = existsSync(path.join(root, rel));
    add(`file:${rel}`, rel, rel, present ? "ok" : "fail", true, present ? "present" : "missing", present ? "存在" : "缺失",
      "Restore the file from the release archive", "从发布包恢复该文件");
  }
}

async function checkInstallSources() {
  try {
    const sources = resolveInstallSources({ profile: "CN" });
    add("download_sources_cn", "Mainland China dependency sources", "国内依赖下载源", "ok", true,
      `npm=${sources.npmRegistry}; PyPI=${sources.pipIndexUrl}; models=${sources.modelHub}; HF=${sources.hfEndpoint}; Paddle=${sources.paddleModelSource}`,
      `npm=${sources.npmRegistry}；PyPI=${sources.pipIndexUrl}；模型=${sources.modelHub}；HF=${sources.hfEndpoint}；Paddle=${sources.paddleModelSource}`,
      platformBootstrap("-NetworkProfile CN", "--network-profile CN"), platformBootstrap("-NetworkProfile CN", "--network-profile CN"));
  } catch (error) {
    add("download_sources_cn", "Mainland China dependency sources", "国内依赖下载源", "fail", true,
      error.message, error.message,
      "Restore src/installSources.js from the release archive", "从发布包恢复 src/installSources.js");
  }
}

async function checkNpm() {
  const present = existsSync(path.join(root, "node_modules", "openclaw", "package.json"));
  add("npm_dependencies", "npm dependencies", "npm 依赖", present ? "ok" : "fail", true,
    present ? "OpenClaw package is installed" : "node_modules is incomplete", present ? "已安装 OpenClaw 包" : "node_modules 不完整",
    "npm install", "运行 npm install");
}

async function checkPython() {
  const python = process.platform === "win32" ? path.join(root, ".venv", "Scripts", "python.exe") : path.join(root, ".venv", "bin", "python");
  if (!existsSync(python)) {
    add("python_venv", "Project Python .venv", "项目 Python .venv", "warn", false, ".venv is missing", "缺少 .venv",
      platformBootstrap("-InstallMode AUTO", "--install-mode AUTO"), platformBootstrap("-InstallMode AUTO", "--install-mode AUTO"));
    return;
  }
  const version = await command(python, ["--version"], 10_000);
  add("python_venv", "Project Python .venv", "项目 Python .venv", version.ok ? "ok" : "warn", false,
    version.ok ? firstLine(version.stdout || version.stderr) : version.error, version.ok ? firstLine(version.stdout || version.stderr) : version.error,
    platformBootstrap("", ""), platformBootstrap("", ""));
  const imports = await command(python, ["-c", "import importlib.util as u,json;mods=['markitdown','paddleocr','faster_whisper','fastapi','uvicorn','sentence_transformers'];print(json.dumps({m:bool(u.find_spec(m)) for m in mods}))"], 20_000);
  let modules = {};
  try { modules = JSON.parse(imports.stdout); } catch {}
  const missing = Object.entries(modules).filter(([, present]) => !present).map(([name]) => name);
  add("python_modules", "OCR/transcription and optional BGE modules", "OCR/转录及可选 BGE 模块", imports.ok && missing.length === 0 ? "ok" : "warn", false,
    imports.ok ? (missing.length ? `missing: ${missing.join(", ")}` : "all modules are importable") : imports.error,
    imports.ok ? (missing.length ? `缺少：${missing.join("、")}` : "全部模块可导入") : imports.error,
    `${quote(python)} -m pip install -r requirements.txt -r requirements-bge-m3.txt`, `${quote(python)} -m pip install -r requirements.txt -r requirements-bge-m3.txt`);
  const model = await command(python, ["-c", "from huggingface_hub import snapshot_download;print(snapshot_download('BAAI/bge-m3',local_files_only=True))"], 20_000);
  add("bge_model", "BGE-M3 local model", "BGE-M3 本地模型", model.ok ? "ok" : "warn", false,
    model.ok ? firstLine(model.stdout) : "model is not fully cached", model.ok ? firstLine(model.stdout) : "模型尚未完整缓存",
    `${quote(python)} scripts/prepare_bge_m3.py --hf-endpoint https://hf-mirror.com`, `${quote(python)} scripts/prepare_bge_m3.py --hf-endpoint https://hf-mirror.com`);
}

async function checkFfmpeg() {
  const result = await command("ffmpeg", ["-version"], 10_000);
  add("ffmpeg", "FFmpeg", "FFmpeg", result.ok ? "ok" : "warn", false,
    result.ok ? firstLine(result.stdout) : "not found", result.ok ? firstLine(result.stdout) : "未找到",
    process.platform === "win32" ? "winget install Gyan.FFmpeg" : "sudo apt install ffmpeg", process.platform === "win32" ? "winget install Gyan.FFmpeg" : "sudo apt install ffmpeg");
}

async function checkExtractor() {
  const result = await command(process.execPath, [path.join(root, "src", "cli.js"), "doctor"], 60_000);
  let doctor = null;
  try { doctor = JSON.parse(result.stdout); } catch {}
  add("extractor", "Extractor doctor", "提取器诊断", result.ok && doctor?.ready ? "ok" : "warn", false,
    doctor ? `available=${(doctor.available || []).join(",")}; missing=${(doctor.missing || []).join(",")}` : result.error,
    doctor ? `可用=${(doctor.available || []).join("、")}；缺少=${(doctor.missing || []).join("、")}` : result.error,
    "npm run doctor", "运行 npm run doctor");
}

async function checkEmbedding() {
  const result = await command(process.execPath, [path.join(root, "scripts", "check_embedding_server.js")], 15_000);
  let payload = null;
  try { payload = JSON.parse(result.stdout); } catch {}
  add("embedding", "BGE-M3 endpoint", "BGE-M3 服务端点", result.ok && payload?.ok ? "ok" : "warn", false,
    payload?.ok ? `${payload.model}; dimensions=${payload.dimensions}` : "not reachable", payload?.ok ? `${payload.model}；维度=${payload.dimensions}` : "无法访问",
    process.platform === "win32" ? "Start-ScheduledTask -TaskName 'OKF Obsidian BGE-M3'" : "systemctl --user restart okf-bge-m3.service",
    process.platform === "win32" ? "Start-ScheduledTask -TaskName 'OKF Obsidian BGE-M3'" : "systemctl --user restart okf-bge-m3.service");
}

async function checkService() {
  const result = process.platform === "win32"
    ? await command("schtasks.exe", ["/Query", "/TN", "OKF Obsidian BGE-M3", "/FO", "LIST"], 10_000)
    : await command("systemctl", ["--user", "is-enabled", "okf-bge-m3.service"], 10_000);
  add("bge_service", "BGE-M3 auto-start service", "BGE-M3 自启动服务", result.ok ? "ok" : "warn", false,
    result.ok ? "installed" : "not installed", result.ok ? "已安装" : "未安装",
    process.platform === "win32" ? "powershell -ExecutionPolicy Bypass -File .\\scripts\\install_bge_service_windows.ps1" : "./scripts/install_bge_service_linux.sh",
    process.platform === "win32" ? "powershell -ExecutionPolicy Bypass -File .\\scripts\\install_bge_service_windows.ps1" : "./scripts/install_bge_service_linux.sh");
}

async function checkObsidian() {
  const plugin = path.join(vault, ".obsidian", "plugins", "okf-obsidian-memory", "manifest.json");
  add("obsidian_plugin", "Obsidian companion plugin", "Obsidian 配套插件", existsSync(plugin) ? "ok" : "warn", false,
    existsSync(plugin) ? plugin : "not installed in selected Vault", existsSync(plugin) ? plugin : "尚未安装到所选 Vault",
    `node scripts/install_obsidian_plugin.js --vault ${quote(vault)}`, `node scripts/install_obsidian_plugin.js --vault ${quote(vault)}`);
  const fullPath = findObsidianExecutable();
  let cli = "obsidian";
  let cliVersion = await command(cli, ["version"], 10_000);
  if (!cliVersion.ok && fullPath) {
    cli = fullPath;
    cliVersion = await command(cli, ["version"], 10_000);
  }
  add("obsidian_cli", "Obsidian CLI", "Obsidian CLI", cliVersion.ok ? "ok" : "warn", false,
    cliVersion.ok ? `${cli}: ${firstLine(cliVersion.stdout)}` : (fullPath || "not found"), cliVersion.ok ? `${cli}: ${firstLine(cliVersion.stdout)}` : (fullPath || "未找到"),
    `npm run verify:obsidian-cli -- --obsidian ${quote("<full-path>")} --vault ${quote(vault)}`, `npm run verify:obsidian-cli -- --obsidian ${quote("<完整路径>")} --vault ${quote(vault)}`);
}

async function checkOpenClaw() {
  const config = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const local = path.join(root, "node_modules", "openclaw", "openclaw.mjs");
  const planResult = existsSync(local) ? await command(process.execPath, [path.join(root, "scripts", "plan_openclaw_install.js"), "--root", root, "--mode", "AUTO"], 90_000) : { ok: false };
  let installPlan = null;
  try { installPlan = JSON.parse(planResult.stdout); } catch {}
  add("openclaw_install_mode", "Safe OpenClaw coexistence plan", "OpenClaw 安全共存方案", planResult.ok && installPlan?.ok ? "ok" : "warn", false,
    installPlan ? `${installPlan.resolvedMode}: ${installPlan.reason}; preserveGateway=${installPlan.preserveExistingGateway}` : planResult.error,
    installPlan ? `${installPlan.resolvedMode}：${installPlan.reason}；保留 Gateway=${installPlan.preserveExistingGateway}` : planResult.error,
    platformBootstrap("-InstallMode AUTO", "--install-mode AUTO"), platformBootstrap("-InstallMode AUTO", "--install-mode AUTO"));
  const memory = existsSync(local) ? await command(process.execPath, [local, "config", "get", "agents.defaults.memorySearch", "--json"], 20_000) : { ok: false };
  let memoryConfig = null;
  try { memoryConfig = JSON.parse(memory.stdout); } catch {}
  const extraPaths = Array.isArray(memoryConfig?.extraPaths) ? memoryConfig.extraPaths : [];
  const expectedExport = path.join(vault, "okf-export").replaceAll("\\", "/").toLowerCase();
  const memoryReady = memory.ok && extraPaths.some((item) => String(item).replaceAll("\\", "/").toLowerCase() === expectedExport);
  add("openclaw_config", "OpenClaw memory configuration", "OpenClaw 记忆配置", memoryReady ? "ok" : "warn", false,
    memoryReady ? `provider=${memoryConfig.provider}; extraPaths includes selected Vault` : (existsSync(config) ? "config exists but selected Vault is not active" : "OpenClaw config is missing"),
    memoryReady ? `供应商=${memoryConfig.provider}；extraPaths 已包含所选 Vault` : (existsSync(config) ? "配置存在，但所选 Vault 未启用" : "缺少 OpenClaw 配置"),
    platformBootstrap("-InstallMode AUTO", "--install-mode AUTO"), platformBootstrap("-InstallMode AUTO", "--install-mode AUTO"));
  const plugins = existsSync(local) ? await command(process.execPath, [local, "plugins", "list", "--json"], 20_000) : { ok: false };
  const pluginReady = plugins.ok && String(plugins.stdout).includes("openclaw-okf-obsidian-memory");
  add("openclaw_plugin", "OpenClaw OKF plugin", "OpenClaw OKF 插件", pluginReady ? "ok" : "warn", false,
    pluginReady ? "installed and discoverable" : "not installed or not discoverable", pluginReady ? "已安装且可发现" : "未安装或无法发现",
    "node scripts/prepare_openclaw_plugin.js --print-path", "运行 node scripts/prepare_openclaw_plugin.js --print-path 后安装输出目录");
  const gateway = existsSync(local) ? await command(process.execPath, [local, "gateway", "status"], 30_000) : { ok: false };
  const gatewayOutput = `${gateway.stdout || ""}\n${gateway.stderr || ""}`;
  const gatewayReady = gateway.ok && /Connectivity probe:\s*ok/i.test(gatewayOutput) && /Runtime:\s*running/i.test(gatewayOutput);
  add("openclaw_gateway", "OpenClaw Gateway auto-start", "OpenClaw Gateway 自启动", gatewayReady ? "ok" : "warn", false,
    gatewayReady ? "service registered, running, and reachable" : "service is missing, stopped, or unreachable",
    gatewayReady ? "服务已注册、正在运行且可访问" : "服务缺失、已停止或无法访问",
    "Run the AUTO installer; it preserves an existing Gateway and installs one only when missing", "运行 AUTO 安装器；已有 Gateway 会保留，仅在缺失时安装");
  const modelProbe = existsSync(local) ? await command(process.execPath, [
    local, "models", "status", "--json", "--probe", "--probe-timeout", "15000", "--probe-max-tokens", "8"
  ], 60_000) : { ok: false };
  let modelStatus = null;
  try { modelStatus = JSON.parse(modelProbe.stdout); } catch {}
  const defaultModel = String(modelStatus?.defaultModel || "");
  const probeResults = Array.isArray(modelStatus?.auth?.probes?.results) ? modelStatus.auth.probes.results : [];
  const defaultProbe = probeResults.find((item) => String(item.model || "") === defaultModel) || probeResults[0];
  const modelReady = modelProbe.ok && defaultProbe?.status === "ok";
  const probeModel = defaultProbe ? String(defaultProbe.model || "") : "";
  const probeLabel = defaultProbe && probeModel.startsWith(`${defaultProbe.provider}/`) ? probeModel : (defaultProbe ? `${defaultProbe.provider}/${probeModel}` : "");
  const probeDetail = defaultProbe ? `${probeLabel}: ${defaultProbe.status}${defaultProbe.error ? ` (${defaultProbe.error})` : ""}` : "no live model probe result";
  add("openclaw_model_auth", "OpenClaw default model live probe", "OpenClaw 默认模型实时探测", modelReady ? "ok" : "warn", false,
    modelReady ? `${defaultModel} authenticated` : probeDetail, modelReady ? `${defaultModel} 认证正常` : probeDetail,
    "openclaw models auth login --provider <provider>; openclaw models status --probe", "重新登录模型供应商，然后运行 openclaw models status --probe");
}

function add(id, name, nameZh, status, required, detail, detailZh, repair, repairZh) { checks.push({ id, name, nameZh, status, required, detail, detailZh, repair, repairZh }); }
async function command(executable, argv, timeoutMs) {
  try { const value = await runProcess(executable, argv, { cwd: root, timeoutMs, stage: `doctor:${path.basename(executable)}` }); return { ok: true, ...value }; }
  catch (error) { return { ok: false, error: error.message, stdout: error.stdout || "", stderr: error.stderr || "" }; }
}
function findObsidianExecutable() {
  const candidates = [process.env.OBSIDIAN_CLI];
  if (process.platform === "win32") candidates.push(
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.com"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Obsidian", "Obsidian.com"),
    ...["C", "D", "E"].map((drive) => `${drive}:\\Program Files\\Obsidian\\Obsidian.com`),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Obsidian", "Obsidian.exe"),
    ...["C", "D", "E"].map((drive) => `${drive}:\\Program Files\\Obsidian\\Obsidian.exe`));
  else if (process.platform === "darwin") candidates.push("/Applications/Obsidian.app/Contents/MacOS/Obsidian");
  else candidates.push("/usr/bin/obsidian", "/usr/local/bin/obsidian", "/snap/bin/obsidian");
  return candidates.filter(Boolean).find(existsSync) || "";
}
function platformBootstrap(winArgs, linuxArgs) { return process.platform === "win32" ? `powershell -ExecutionPolicy Bypass -File .\\scripts\\bootstrap_windows.ps1 ${winArgs}`.trim() : `./scripts/bootstrap_linux.sh ${linuxArgs}`.trim(); }
function firstLine(value) { return String(value || "").trim().split(/\r?\n/)[0] || ""; }
function quote(value) { return `"${String(value).replaceAll('"', '\\"')}"`; }
function parseArgs(argv) { const parsed = {}; for (let i = 0; i < argv.length; i += 1) { if (!argv[i].startsWith("--")) continue; const key = argv[i].slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()); const next = argv[i + 1]; if (!next || next.startsWith("--")) parsed[key] = true; else { parsed[key] = next; i += 1; } } return parsed; }
