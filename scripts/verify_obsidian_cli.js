#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../src/process.js";

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const vault = path.resolve(args.vault || path.join(root, "examples", "vault"));
const pluginId = args.pluginId || "okf-obsidian-memory";
const timeoutMs = Number(args.timeoutMs || 30_000);
const checks = [];
const issues = [];
const discovery = await findObsidianCli(args.obsidian);

if (!discovery.command) {
  finish({
    ok: false,
    skipped: false,
    reason: "obsidian_cli_not_found",
    searched: discovery.searched,
    message: "Obsidian CLI/executable was not found. Enable CLI in Settings > General or pass --obsidian <full-path>.",
    messageZh: "未找到 Obsidian CLI/可执行文件。请在设置 > 常规中启用 CLI，或传入 --obsidian <完整路径>。",
    repair: "npm run verify:obsidian-cli -- --obsidian \"<full-path-to-Obsidian>\" --vault \"<vault>\""
  });
} else if (!existsSync(vault)) {
  issues.push(issue("vault_missing", vault, "Vault path does not exist / Vault 路径不存在"));
  finishResult();
} else {
  await runCheck("version", ["version"], { requireOutput: true });
  const vaults = await runCheck("vaults", ["vaults", "verbose"]);
  const vaultName = resolveVaultName(vaults.stdout, vault);
  if (!vaultName) {
    issues.push(issue("obsidian_vault_not_registered", vault, "Vault path is not registered in Obsidian / Obsidian 尚未注册该 Vault 路径"));
    finishResult();
  } else {
  await runCheck("commands", ["commands", `vault=${vaultName}`], { expect: [`${pluginId}:`] });
  await runCheck("plugin_reload", ["plugin:reload", `id=${pluginId}`, `vault=${vaultName}`]);
  const expectedVersion = await installedPluginVersion(vault, pluginId);
  const pluginExpect = ["OKF Obsidian Memory", "enabled\ttrue"];
  if (expectedVersion) pluginExpect.push(`version\t${expectedVersion}`);
  await runCheck("plugin_loaded", ["plugin", `id=${pluginId}`, `vault=${vaultName}`], { expect: pluginExpect });
  const errors = await runCheck("dev_errors", ["dev:errors", `vault=${vaultName}`], { requireOutput: true });
  const output = `${errors.stdout || ""}\n${errors.stderr || ""}`;
  if (errors.ok && !/no errors captured/i.test(output)) {
    issues.push(issue("obsidian_plugin_error", "dev:errors", trim(output, 2000)));
  }
  finishResult();
  }
}

async function findObsidianCli(explicit) {
  const candidates = unique([
    explicit,
    process.env.OBSIDIAN_CLI,
    "obsidian",
    ...(process.platform === "win32" ? windowsCandidates() : []),
    ...(process.platform === "darwin" ? ["/Applications/Obsidian.app/Contents/MacOS/Obsidian"] : []),
    ...(process.platform === "linux" ? ["/usr/bin/obsidian", "/usr/local/bin/obsidian", "/snap/bin/obsidian"] : [])
  ]);
  const searched = [];
  for (const command of candidates) {
    searched.push(command);
    if (path.isAbsolute(command) && !existsSync(command)) continue;
    try {
      const result = await runProcess(command, ["version"], { timeoutMs: 5_000, stage: "Obsidian CLI discovery" });
      return { command, searched, discoveryOutput: trim(result.stdout || result.stderr) };
    } catch (error) {
      // An installed desktop executable can have CLI output disabled. Its full path is still
      // returned so the required command checks report a real failure instead of a false skip.
      if (path.isAbsolute(command) && existsSync(command) && error.code !== "PROCESS_TIMEOUT") {
        return { command, searched, discoveryOutput: "" };
      }
    }
  }
  return { command: "", searched };
}

function windowsCandidates() {
  const roots = unique([
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.com"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Obsidian", "Obsidian.com"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Obsidian", "Obsidian.com"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Obsidian", "Obsidian.com"),
    ...["C", "D", "E"].map((drive) => `${drive}:\\Program Files\\Obsidian\\Obsidian.com`),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Obsidian", "Obsidian.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Obsidian", "Obsidian.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Obsidian", "Obsidian.exe"),
    ...["C", "D", "E"].map((drive) => `${drive}:\\Program Files\\Obsidian\\Obsidian.exe`)
  ]);
  return ["obsidian", "obsidian.com", "Obsidian.com", ...roots, "obsidian.exe", "Obsidian.exe"];
}

async function runCheck(name, commandArgs, { expect = [], requireOutput = false } = {}) {
  try {
    const result = await runProcess(discovery.command, commandArgs, { cwd: root, timeoutMs, maxBuffer: 10 * 1024 * 1024, stage: `Obsidian ${name}` });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    if (requireOutput && !output) issues.push(issue("obsidian_cli_empty_output", name, "Command returned no verifiable output / 命令未返回可验证输出"));
    for (const expected of expect) {
      if (!output.includes(expected)) issues.push(issue("obsidian_cli_missing_expected_output", name, `Expected output to include ${expected} / 输出应包含 ${expected}`));
    }
    const check = { name, ok: true, args: commandArgs, stdout: trim(result.stdout), stderr: trim(result.stderr), durationMs: result.durationMs };
    checks.push(check);
    return check;
  } catch (error) {
    const check = { name, ok: false, args: commandArgs, error: error.message, stdout: trim(error.stdout), stderr: trim(error.stderr) };
    checks.push(check);
    issues.push(issue("obsidian_cli_check_failed", name, check.error));
    return check;
  }
}

function finishResult() {
  finish({ ok: issues.length === 0, skipped: false, obsidian: discovery.command, discoveryOutput: discovery.discoveryOutput, vault, pluginId, syntax: "key=value", checks, issues });
}
function finish(result) { console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
function issue(code, target, message) { return { code, target, message }; }
function trim(value, max = 1000) { const text = String(value || "").trim(); return text.length > max ? `${text.slice(0, max)}...` : text; }
function unique(values) { return [...new Set(values.filter(Boolean).map(String))]; }
async function installedPluginVersion(vaultPath, id) {
  try {
    const manifest = JSON.parse(await readFile(path.join(vaultPath, ".obsidian", "plugins", id, "manifest.json"), "utf8"));
    return String(manifest.version || "");
  } catch {
    issues.push(issue("obsidian_plugin_manifest_missing", id, "Installed plugin manifest is missing or invalid / 已安装插件的 manifest 缺失或无效"));
    return "";
  }
}
function resolveVaultName(output, targetPath) {
  const target = path.resolve(targetPath).replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  for (const line of String(output || "").split(/\r?\n/)) {
    const [name, ...pathParts] = line.split("\t");
    const candidate = pathParts.join("\t").trim();
    if (!name || !candidate) continue;
    const normalized = path.resolve(candidate).replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
    if (normalized === target) return name.trim();
  }
  return "";
}
function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else { parsed[key] = next; i += 1; }
  }
  return parsed;
}
