import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { buildPatch } from "../scripts/configure_openclaw_memory.js";
import { resolveInstallPlan } from "../src/installPlan.js";
import { resolveInstallSources } from "../src/installSources.js";
import { completeInstallSnapshot, createInstallSnapshot, restoreInstallSnapshot } from "../src/installSnapshot.js";

const execFileAsync = promisify(execFile);

test("CN dependency profile routes npm, PyPI, Hugging Face, and PaddleOCR to domestic sources", () => {
  const sources = resolveInstallSources({ profile: "CN" });
  assert.equal(sources.npmRegistry, "https://registry.npmmirror.com");
  assert.equal(sources.pipIndexUrl, "https://pypi.tuna.tsinghua.edu.cn/simple");
  assert.equal(sources.hfEndpoint, "https://hf-mirror.com");
  assert.equal(sources.modelHub, "modelscope");
  assert.equal(sources.paddleModelSource, "modelscope");
});

test("GLOBAL and CUSTOM dependency profiles remain explicit and reject insecure remote sources", () => {
  assert.equal(resolveInstallSources({ profile: "GLOBAL" }).modelHub, "huggingface");
  const custom = resolveInstallSources({
    profile: "CUSTOM",
    npmRegistry: "https://npm.internal.example/",
    pipIndexUrl: "https://pypi.internal.example/simple/",
    hfEndpoint: "https://hf.internal.example/",
    modelHub: "modelscope",
    paddleModelSource: "aistudio"
  });
  assert.equal(custom.npmRegistry, "https://npm.internal.example");
  assert.throws(() => resolveInstallSources({
    profile: "CUSTOM",
    npmRegistry: "http://npm.internal.example",
    pipIndexUrl: "https://pypi.internal.example/simple",
    hfEndpoint: "https://hf.internal.example",
    modelHub: "modelscope",
    paddleModelSource: "aistudio"
  }), /HTTPS/i);
});

test("AUTO reuses a healthy existing OpenClaw vector provider and preserves its gateway", () => {
  const plan = resolveInstallPlan({
    configExists: true,
    memorySearch: { provider: "openai-compatible", model: "existing-embedding" },
    memoryStatuses: [{ status: { vector: { enabled: true } } }],
    embeddingProbeOk: true,
    gatewayStatus: { service: { loaded: true, runtime: { status: "running" } } }
  });
  assert.equal(plan.resolvedMode, "REUSE_EXISTING");
  assert.equal(plan.installBge, false);
  assert.equal(plan.installGateway, false);
  assert.equal(plan.restartGateway, true);
  assert.equal(plan.preserveExistingGateway, true);
});

test("AUTO fails closed to SIDECAR when an existing semantic provider is configured but unhealthy", () => {
  const plan = resolveInstallPlan({
    configExists: true,
    memorySearch: { provider: "voyage", model: "voyage-3" },
    memoryStatuses: [{ status: { vector: { enabled: true } } }],
    embeddingProbeOk: false
  });
  assert.equal(plan.resolvedMode, "SIDECAR");
  assert.equal(plan.configureProvider, false);
  assert.equal(plan.indexMemory, false);
  assert.equal(plan.enableActiveMemory, false);
});

test("AUTO deploys isolated CPU BGE only when OpenClaw has no semantic provider", () => {
  const plan = resolveInstallPlan({
    configExists: true,
    memorySearch: { provider: "none" },
    gatewayStatus: { service: { loaded: false } }
  });
  assert.equal(plan.resolvedMode, "ISOLATED");
  assert.equal(plan.installBge, true);
  assert.equal(plan.configureProvider, true);
  assert.equal(plan.installGateway, true);
});

test("explicit ISOLATED cannot replace an existing provider without an override", () => {
  assert.throws(() => resolveInstallPlan({
    requestedMode: "ISOLATED",
    configExists: true,
    memorySearch: { provider: "ollama", model: "existing" }
  }), /cannot|replace/i);
});

test("REUSE_EXISTING memory patch appends only the OKF path and preserves provider and Active Memory", () => {
  const patch = buildPatch({
    exportDir: "D:/Vault/okf-export",
    args: { mode: "REUSE_EXISTING", provider: "none", activeMemory: true },
    existingMemorySearch: {
      provider: "voyage",
      model: "voyage-3",
      extraPaths: ["D:/Existing/memory"]
    },
    existingActiveMemory: { enabled: true, config: { promptStyle: "custom" } }
  });
  assert.deepEqual(patch.agents.defaults.memorySearch, {
    extraPaths: [path.resolve("D:/Existing/memory").replaceAll("\\", "/"), path.resolve("D:/Vault/okf-export").replaceAll("\\", "/")]
  });
  assert.equal("plugins" in patch, false);
});

test("install snapshot restores existing OpenClaw config and Vault plugin without touching user notes", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "okf-existing-install-"));
  const root = path.join(temporary, "project");
  const vault = path.join(temporary, "vault");
  const openclawConfig = path.join(temporary, ".openclaw", "openclaw.json");
  const pluginDir = path.join(vault, ".obsidian", "plugins", "okf-obsidian-memory");
  const userNote = path.join(vault, "Personal existing note.md");
  try {
    await mkdir(root, { recursive: true });
    await mkdir(path.dirname(openclawConfig), { recursive: true });
    await mkdir(pluginDir, { recursive: true });
    await writeFile(openclawConfig, '{"existing":true}\n');
    await writeFile(path.join(vault, ".obsidian", "community-plugins.json"), '["unrelated-plugin"]\n');
    await writeFile(path.join(pluginDir, "main.js"), "old plugin\n");
    await writeFile(path.join(pluginDir, "data.json"), '{"userSetting":true}\n');
    await writeFile(path.join(vault, "okf-obsidian.config.json"), '{"notesDir":"my-notes"}\n');
    await writeFile(userNote, "do not overwrite\n");

    const { snapshotDir } = await createInstallSnapshot({
      root,
      vault,
      openclawConfig,
      plan: { resolvedMode: "SIDECAR" },
      snapshotRoot: path.join(temporary, "snapshots")
    });
    await writeFile(openclawConfig, '{"existing":false}\n');
    await writeFile(path.join(pluginDir, "main.js"), "new plugin\n");
    await writeFile(path.join(pluginDir, "new-file.js"), "new\n");
    await writeFile(path.join(vault, ".obsidian", "community-plugins.json"), '["changed"]\n');
    await restoreInstallSnapshot(snapshotDir);

    assert.equal(await readFile(openclawConfig, "utf8"), '{"existing":true}\n');
    assert.equal(await readFile(path.join(pluginDir, "main.js"), "utf8"), "old plugin\n");
    assert.equal(await readFile(path.join(pluginDir, "data.json"), "utf8"), '{"userSetting":true}\n');
    await assert.rejects(readFile(path.join(pluginDir, "new-file.js"), "utf8"), /ENOENT/);
    assert.equal(await readFile(path.join(vault, ".obsidian", "community-plugins.json"), "utf8"), '["unrelated-plugin"]\n');
    assert.equal(await readFile(path.join(vault, "okf-obsidian.config.json"), "utf8"), '{"notesDir":"my-notes"}\n');
    assert.equal(await readFile(userNote, "utf8"), "do not overwrite\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("plan CLI supports deterministic existing-install fixtures", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "okf-install-plan-"));
  try {
    const fixture = path.join(temporary, "state.json");
    await writeFile(fixture, JSON.stringify({
      configExists: true,
      memorySearch: { provider: "openai-compatible", model: "existing" },
      memoryStatuses: [{ status: { vector: { enabled: true } } }],
      embeddingProbeOk: true,
      gatewayStatus: { service: { loaded: true, runtime: { status: "running" } } }
    }));
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve("scripts/plan_openclaw_install.js"),
      "--mock-state", fixture,
      "--mode", "AUTO"
    ], { timeout: 20_000, windowsHide: true });
    const result = JSON.parse(stdout);
    assert.equal(result.resolvedMode, "REUSE_EXISTING");
    assert.equal(result.installBge, false);
    assert.equal(result.preserveExistingGateway, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("completed snapshot records the mode and renders it into the Agent handoff", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "okf-install-handoff-"));
  const root = path.join(temporary, "project");
  const vault = path.join(temporary, "vault");
  try {
    await mkdir(root, { recursive: true });
    await mkdir(vault, { recursive: true });
    const { snapshotDir } = await createInstallSnapshot({
      root,
      vault,
      openclawConfig: path.join(temporary, "missing-openclaw.json"),
      plan: { resolvedMode: "SIDECAR", existingProvider: "voyage", existingModel: "voyage-3" },
      snapshotRoot: path.join(temporary, "snapshots")
    });
    await completeInstallSnapshot(snapshotDir, ["append_okf_export_path"]);
    const output = path.join(temporary, "AGENT_HANDOFF.md");
    await execFileAsync(process.execPath, [
      path.resolve("scripts/generate_agent_handoff.js"),
      "--root", root,
      "--vault", vault,
      "--template", path.resolve("AGENT_HANDOFF.template.md"),
      "--output", output
    ], { timeout: 20_000, windowsHide: true });
    const handoff = await readFile(output, "utf8");
    assert.match(handoff, /安装模式：`SIDECAR`/);
    assert.match(handoff, /Sidecar：保留目标 OpenClaw/);
    assert.ok(handoff.includes(snapshotDir));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("snapshot CLI accepts Base64 plans for PowerShell-safe argument transport", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "okf-snapshot-base64-"));
  const root = path.join(temporary, "project");
  const vault = path.join(temporary, "vault");
  try {
    await mkdir(root, { recursive: true });
    await mkdir(vault, { recursive: true });
    const plan = { resolvedMode: "REUSE_EXISTING", existingProvider: "openai-compatible", changes: ["preserve_gateway"] };
    const encoded = Buffer.from(JSON.stringify(plan), "utf8").toString("base64");
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve("scripts/install_snapshot.js"), "create",
      "--root", root,
      "--vault", vault,
      "--openclaw-config", path.join(temporary, "openclaw.json"),
      "--plan-base64", encoded,
      "--snapshot-root", path.join(temporary, "snapshots")
    ], { timeout: 20_000, windowsHide: true });
    const result = JSON.parse(stdout);
    assert.equal(result.manifest.plan.resolvedMode, "REUSE_EXISTING");
    assert.deepEqual(result.manifest.plan.changes, ["preserve_gateway"]);
    const changes = ["snapshot_openclaw_config", "preserve_existing_gateway_service"];
    const changesBase64 = Buffer.from(JSON.stringify(changes), "utf8").toString("base64");
    await execFileAsync(process.execPath, [
      path.resolve("scripts/install_snapshot.js"), "complete",
      "--snapshot", result.snapshotDir,
      "--changes-base64", changesBase64
    ], { timeout: 20_000, windowsHide: true });
    const installState = JSON.parse(await readFile(path.join(root, ".okf-install", "last-install.json"), "utf8"));
    assert.deepEqual(installState.appliedChanges, changes);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
