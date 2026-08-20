#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    vault: "./examples/vault",
    exportDir: "",
    provider: "none",
    model: "",
    baseUrl: "",
    apiKey: "",
    openclaw: process.env.OPENCLAW_BIN || "openclaw",
    activeMemory: false,
    activeMemoryAgent: "main",
    activeMemoryModelFallback: "",
    index: false,
    mode: "LEGACY",
    allowProviderReplace: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.openclaw = await resolveOpenClawBin(args.openclaw);
  const exportDir = path.resolve(args.exportDir || path.join(args.vault, "okf-export"));
  const existingMemorySearch = await readJsonConfig(args.openclaw, "agents.defaults.memorySearch", {});
  const existingActiveMemory = await readJsonConfig(args.openclaw, "plugins.entries.active-memory", null);
  const patch = buildPatch({ exportDir, args, existingMemorySearch, existingActiveMemory });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "okf-openclaw-memory-"));
  const patchPath = path.join(tempDir, "patch.json");
  try {
    await writeFile(patchPath, JSON.stringify(patch, null, 2), "utf8");
    await runOpenClaw(args.openclaw, ["config", "patch", "--file", patchPath]);
    await runOpenClaw(args.openclaw, ["config", "validate"]);
    if (args.index) {
      await runOpenClaw(args.openclaw, ["memory", "index", "--force"], { maxBuffer: 20 * 1024 * 1024 });
    }
    console.log(JSON.stringify({
      ok: true,
      exportDir,
      provider: args.provider,
      mode: normalizeMode(args.mode),
      activeMemory: Boolean(args.activeMemory),
      activeMemoryPreserved: Boolean(args.activeMemory && existingActiveMemory),
      indexed: Boolean(args.index)
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function resolveOpenClawBin(value) {
  if (value && value !== "openclaw") return value;
  const local = path.resolve(__dirname, "..", "node_modules", "openclaw", "openclaw.mjs");
  try {
    await access(local);
    return local;
  } catch {
    return value || "openclaw";
  }
}

async function runOpenClaw(openclawBin, argv, options = {}) {
  const isMjs = /\.mjs$/i.test(openclawBin);
  return execFileAsync(isMjs ? process.execPath : openclawBin, isMjs ? [openclawBin, ...argv] : argv, {
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024,
    ...options
  });
}

async function readJsonConfig(openclawBin, pathValue, fallback) {
  try {
    const { stdout } = await runOpenClaw(openclawBin, ["config", "get", pathValue, "--json"]);
    return JSON.parse(stdout);
  } catch {
    return fallback;
  }
}

export function buildPatch({ exportDir, args, existingMemorySearch = {}, existingActiveMemory = null }) {
  const mode = normalizeMode(args.mode);
  const exportPath = toOpenClawPath(exportDir);
  const extraPaths = mergePaths(existingMemorySearch?.extraPaths, exportPath);
  const memorySearch = { extraPaths };

  if (mode === "ISOLATED" || mode === "LEGACY") {
    const existingProvider = String(existingMemorySearch?.provider || "");
    if (mode === "ISOLATED" && existingProvider && existingProvider !== "none" && !args.allowProviderReplace) {
      throw new Error("ISOLATED cannot replace an existing OpenClaw memory provider without --allow-provider-replace.");
    }
    memorySearch.provider = args.provider;
    if (args.model) memorySearch.model = args.model;
    if (args.provider === "none") {
      memorySearch.query = {
        hybrid: {
          enabled: true,
          vectorWeight: 0,
          textWeight: 1
        }
      };
    } else {
      memorySearch.query = {
        hybrid: {
          enabled: true,
          vectorWeight: 0.75,
          textWeight: 0.25
        }
      };
    }
    if (args.provider === "openai-compatible") {
      memorySearch.remote = {
        baseUrl: args.baseUrl || process.env.OKF_EMBEDDING_BASE_URL || "http://127.0.0.1:8008/v1",
        apiKey: args.apiKey || process.env.OKF_EMBEDDING_API_KEY || "okf-local"
      };
    }
    if (args.provider === "ollama" && args.baseUrl) {
      memorySearch.remote = { baseUrl: args.baseUrl };
    }
  }

  const patch = {
    agents: {
      defaults: {
        memorySearch
      }
    }
  };

  if (args.activeMemory && !existingActiveMemory) {
    patch.plugins = {
      entries: {
        "active-memory": {
          enabled: true,
          config: {
            enabled: true,
            agents: [String(args.activeMemoryAgent || "main")],
            allowedChatTypes: ["direct"],
            queryMode: "recent",
            promptStyle: "balanced",
            timeoutMs: 15000,
            setupGraceTimeoutMs: 30000,
            maxSummaryChars: 320,
            persistTranscripts: false,
            logging: true,
            toolsAllow: ["memory_search", "memory_get"],
            promptAppend: "Prefer OKF Obsidian notes when they clearly match the current user request. Return NONE if the match is weak."
          }
        }
      }
    };
    if (args.activeMemoryModelFallback) {
      patch.plugins.entries["active-memory"].config.modelFallback = args.activeMemoryModelFallback;
    }
  }

  return patch;
}

export function normalizeMode(value = "LEGACY") {
  const mode = String(value || "LEGACY").replaceAll("-", "_").toUpperCase();
  if (!["LEGACY", "REUSE_EXISTING", "SIDECAR", "ISOLATED"].includes(mode)) {
    throw new Error(`Unsupported OpenClaw memory install mode: ${value}`);
  }
  return mode;
}

function toOpenClawPath(value) {
  return path.resolve(value).replaceAll("\\", "/");
}

function mergePaths(existing, nextPath) {
  const values = Array.isArray(existing) ? existing : [];
  const seen = new Set();
  const merged = [];
  for (const item of [...values, nextPath]) {
    if (!item) continue;
    const normalized = toOpenClawPath(item);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
