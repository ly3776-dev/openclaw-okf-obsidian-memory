#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(parseArgs(process.argv.slice(2)).root || process.cwd());
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([
  ".git",
  ".tmp",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
  ".okf-install"
]);
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico",
  ".pdf", ".mp3", ".wav", ".m4a", ".mp4", ".mov", ".mkv",
  ".pyc", ".zip", ".gz", ".7z", ".onnx", ".bin"
]);

const PATTERNS = [
  {
    name: "openai_style_api_key",
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g
  },
  {
    name: "tavily_api_key",
    regex: /\btvly-[A-Za-z0-9_-]{20,}\b/g
  },
  {
    name: "bearer_token_literal",
    regex: /\bBearer\s+([A-Za-z0-9._-]{24,})\b/g,
    group: 1
  },
  {
    name: "openclaw_gateway_token_assignment",
    regex: /\bOPENCLAW_GATEWAY_TOKEN\s*=\s*["']?([A-Za-z0-9._-]{24,})["']?/g,
    group: 1
  },
  {
    name: "json_secret_value",
    regex: /"(?:apiKey|llmApiKey|embeddingApiKey|tavilyApiKey|gatewayToken|token)"\s*:\s*"([^"<>\s][^"]{15,})"/g,
    group: 1,
    allow: (value) => ["okf-local"].includes(value) || value.startsWith("$")
  }
];

const issues = [];
const scanned = [];
await scanDir(ROOT);

const result = {
  ok: issues.length === 0,
  root: ROOT,
  scannedFiles: scanned.length,
  issues
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function parseArgs(argv) {
  const args = {};
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

async function scanDir(dir) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await scanDir(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (shouldSkipFile(full)) continue;
    await scanFile(full);
  }
}

function shouldSkipFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return true;
  const rel = path.relative(ROOT, filePath).replaceAll("\\", "/");
  if (rel.includes("/.okf-cache/")) return true;
  return false;
}

async function scanFile(filePath) {
  let text = "";
  try {
    const raw = await readFile(filePath);
    if (raw.length > MAX_FILE_BYTES || raw.includes(0)) return;
    text = raw.toString("utf8");
  } catch {
    return;
  }
  scanned.push(path.relative(ROOT, filePath).replaceAll("\\", "/"));
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      const value = match[pattern.group || 0] || "";
      if (pattern.allow && pattern.allow(value)) continue;
      issues.push({
        file: path.relative(ROOT, filePath).replaceAll("\\", "/"),
        line: lineForIndex(text, match.index || 0),
        pattern: pattern.name,
        match: redact(value)
      });
    }
  }
}

function lineForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function redact(value) {
  const text = String(value || "");
  if (text.length <= 10) return "***";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}
