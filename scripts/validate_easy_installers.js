#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const issues = [];
const requiredFiles = [
  "INSTALL_WINDOWS.cmd",
  "install-linux.sh",
  "AGENT_HANDOFF.template.md",
  "scripts/easy_install_windows.ps1",
  "scripts/generate_agent_handoff.js",
  "scripts/install_openclaw_plugin.js",
  "scripts/plan_openclaw_install.js",
  "scripts/install_snapshot.js",
  "scripts/resolve_install_sources.js",
  "src/installPlan.js",
  "src/installSnapshot.js",
  "src/installSources.js"
];

for (const file of requiredFiles) {
  try { await readFile(path.join(root, file), "utf8"); }
  catch { issues.push({ code: "missing_file", file }); }
}

await validateLaunchers();
await validateGeneratedHandoff();
await validateInstallModes();
if (process.platform === "win32") await validatePowerShellSyntax();

const result = { ok: issues.length === 0, files: requiredFiles, issues };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

async function validateLaunchers() {
  const windows = await safeRead("INSTALL_WINDOWS.cmd");
  const powershell = await safeRead("scripts/easy_install_windows.ps1");
  const linux = await safeRead("install-linux.sh");
  const template = await safeRead("AGENT_HANDOFF.template.md");
  requireText(windows, "scripts\\easy_install_windows.ps1", "windows_launcher_target", "INSTALL_WINDOWS.cmd");
  for (const token of ["bootstrap_windows.ps1", "-InstallMode", "-InstallService", "-NetworkProfile", "generate_agent_handoff.js"]) {
    requireText(powershell, token, "windows_easy_installer_contract", "scripts/easy_install_windows.ps1");
  }
  for (const token of ["bootstrap_linux.sh", "--install-mode", "--install-service", "--network-profile", "generate_agent_handoff.js", "systemctl --user"]) {
    requireText(linux, token, "linux_easy_installer_contract", "install-linux.sh");
  }
  for (const token of ["{{PROJECT_ROOT}}", "{{VAULT_PATH}}", "{{INSTALL_MODE}}", "{{RECOVERY_SNAPSHOT}}", "okf_obsidian_ingest", "okf_obsidian_recall", "okf_obsidian_okf_export"]) {
    requireText(template, token, "agent_template_contract", "AGENT_HANDOFF.template.md");
  }
  const openclawInstaller = await safeRead("scripts/install_openclaw_plugin.js");
  for (const token of ["plugins", "install", "plugins.load.paths", "registry", "--refresh", "removedOldPaths"]) {
    requireText(openclawInstaller, token, "openclaw_upgrade_contract", "scripts/install_openclaw_plugin.js");
  }
  const windowsBootstrap = await safeRead("scripts/bootstrap_windows.ps1");
  const linuxBootstrap = await safeRead("scripts/bootstrap_linux.sh");
  for (const [source, file] of [[windowsBootstrap, "scripts/bootstrap_windows.ps1"], [linuxBootstrap, "scripts/bootstrap_linux.sh"]]) {
    for (const token of ["plan_openclaw_install.js", "install_snapshot.js", "resolve_install_sources.js", "OKF_MODEL_HUB", "PADDLE_PDX_MODEL_SOURCE", "REUSE_EXISTING", "SIDECAR", "ISOLATED"]) {
      requireText(source, token, "safe_install_mode_contract", file);
    }
    if (source.includes("gateway install --force")) issues.push({ code: "destructive_gateway_force", file });
  }
}

async function validateInstallModes() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "okf-install-mode-"));
  try {
    const cases = [
      {
        expected: "REUSE_EXISTING",
        state: { configExists: true, memorySearch: { provider: "openai-compatible", model: "existing" }, memoryStatuses: [{ status: { vector: { enabled: true } } }], embeddingProbeOk: true, gatewayStatus: { service: { loaded: true, runtime: { status: "running" } } } }
      },
      {
        expected: "SIDECAR",
        state: { configExists: true, memorySearch: { provider: "voyage", model: "existing" }, memoryStatuses: [{ status: { vector: { enabled: true } } }], embeddingProbeOk: false, gatewayStatus: {} }
      },
      {
        expected: "ISOLATED",
        state: { configExists: true, memorySearch: { provider: "none" }, memoryStatuses: [], embeddingProbeOk: false, gatewayStatus: {} }
      }
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const fixture = path.join(temporary, `state-${index}.json`);
      await writeFile(fixture, JSON.stringify(cases[index].state));
      const { stdout } = await execFileAsync(process.execPath, [
        path.join(root, "scripts", "plan_openclaw_install.js"),
        "--mock-state", fixture,
        "--mode", "AUTO"
      ], { cwd: root, windowsHide: true, timeout: 20_000 });
      const plan = JSON.parse(stdout);
      if (plan.resolvedMode !== cases[index].expected) issues.push({ code: "install_mode_resolution", expected: cases[index].expected, actual: plan.resolvedMode });
    }
  } catch (error) {
    issues.push({ code: "install_mode_validation_failed", message: error.message });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function validateGeneratedHandoff() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "okf-agent-handoff-"));
  try {
    const vault = path.join(temporary, "Vault With Spaces");
    const output = path.join(temporary, "AGENT_HANDOFF.md");
    await mkdir(vault, { recursive: true });
    await execFileAsync(process.execPath, [
      path.join(root, "scripts", "generate_agent_handoff.js"),
      "--root", root,
      "--vault", vault,
      "--platform", "ValidationOS",
      "--output", output
    ], { cwd: root, windowsHide: true, timeout: 20_000 });
    const rendered = await readFile(output, "utf8");
    if (/\{\{[A-Z0-9_]+\}\}/.test(rendered)) issues.push({ code: "unresolved_agent_token", file: output });
    for (const value of [root, vault, "ValidationOS", "okf_obsidian_ingest", "openclaw memory status --index --deep"]) {
      if (!rendered.includes(value)) issues.push({ code: "generated_agent_value_missing", value });
    }
    if (/\bsk-[A-Za-z0-9_-]{20,}\b/.test(rendered)) issues.push({ code: "agent_file_contains_secret" });
  } catch (error) {
    issues.push({ code: "agent_generation_failed", message: error.message });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function validatePowerShellSyntax() {
  const files = ["scripts/easy_install_windows.ps1", "scripts/bootstrap_windows.ps1", "scripts/install_bge_service_windows.ps1"];
  for (const file of files) {
    const absolute = path.join(root, file).replaceAll("'", "''");
    const command = `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${absolute}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}`;
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { cwd: root, windowsHide: true, timeout: 20_000 });
    } catch (error) {
      issues.push({ code: "powershell_syntax_error", file, message: String(error.stderr || error.stdout || error.message).trim() });
    }
  }
}

async function safeRead(file) {
  try { return await readFile(path.join(root, file), "utf8"); }
  catch { return ""; }
}

function requireText(source, token, code, file) {
  if (!source.includes(token)) issues.push({ code, file, missing: token });
}
