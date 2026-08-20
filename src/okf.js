import path from "node:path";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { parseDocument, stringify as stringifyYaml } from "yaml";

export const OKF_SPEC_VERSION = "0.1";
const RESERVED_MARKDOWN = new Set(["index.md", "log.md"]);

export async function validateOkfVault({ vault, notesDir = "concepts", strictLinks = true } = {}) {
  if (!vault) throw new Error("vault path is required");
  const files = await collectMarkdownFiles(path.join(vault, notesDir));
  const issues = [];
  const notes = [];

  for (const filePath of files) {
    const rel = path.relative(vault, filePath).replaceAll("\\", "/");
    const name = path.basename(filePath);
    const raw = await readFile(filePath, "utf8");
    if (RESERVED_MARKDOWN.has(name)) continue;
    const parsed = parseMarkdownWithFrontmatter(raw);
    if (!parsed.frontmatter) {
      issues.push(issue("missing_frontmatter", rel, "Markdown file is missing YAML frontmatter."));
      continue;
    }
    if (parsed.errors.length) {
      issues.push(issue("invalid_frontmatter", rel, parsed.errors.join("; ")));
    }
    if (!parsed.data.type) {
      issues.push(issue("missing_type", rel, "OKF concept files require a non-empty type field."));
    }
    if (!parsed.body.trim()) {
      issues.push(issue("empty_body", rel, "OKF concept files should contain non-empty Markdown body."));
    }
    if (strictLinks && /\[\[[^\]]+\]\]/.test(raw)) {
      issues.push(issue("obsidian_wikilink", rel, "Strict OKF export should use standard Markdown links, not Obsidian wiki links."));
    }
    notes.push({ path: rel, data: parsed.data, body: parsed.body });
  }

  return {
    ok: issues.length === 0,
    specVersion: OKF_SPEC_VERSION,
    checked: notes.length,
    issues
  };
}

export async function exportStrictOkf({ vault, outputDir, notesDir = "concepts" } = {}) {
  if (!vault) throw new Error("vault path is required");
  const target = outputDir || path.join(vault, "okf-export");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  const sourceFiles = await collectMarkdownFiles(path.join(vault, notesDir));
  const exported = [];
  for (const filePath of sourceFiles) {
    const raw = await readFile(filePath, "utf8");
    const parsed = parseMarkdownWithFrontmatter(raw);
    if (!parsed.frontmatter || parsed.errors.length || !parsed.data.type) continue;
    const relative = path.relative(path.join(vault, notesDir), filePath).replaceAll("\\", "/");
    const targetPath = path.join(target, relative);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, normalizeOkfMarkdown(parsed, vault), "utf8");
    exported.push(path.relative(target, targetPath).replaceAll("\\", "/"));
  }

  await writeFile(path.join(target, "index.md"), renderOkfIndex(exported), "utf8");
  await writeFile(path.join(target, "log.md"), renderOkfLog(exported), "utf8");
  const validation = await validateOkfVault({ vault: target, notesDir: ".", strictLinks: true });
  return {
    ok: validation.ok,
    specVersion: OKF_SPEC_VERSION,
    outputDir: target,
    exported: exported.length,
    validation
  };
}

function normalizeOkfMarkdown(parsed, vault) {
  const data = {
    type: parsed.data.type || "Concept",
    title: parsed.data.title || "Untitled",
    description: parsed.data.description || "",
    resource: normalizeResource(parsed.data.resource || "inline-input", vault),
    tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : [],
    timestamp: parsed.data.timestamp || new Date().toISOString(),
    ...Object.fromEntries(Object.entries(parsed.data).filter(([key]) => !["type", "title", "description", "resource", "tags", "timestamp"].includes(key)))
  };
  const body = parsed.body.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "[$2]($1.md)").replace(/\[\[([^\]]+)\]\]/g, "[$1]($1.md)");
  return `${renderFrontmatter(data)}\n\n${body.trim()}\n`;
}

function renderOkfIndex(files) {
  const rows = files.map((file) => `- [${file.replace(/\.md$/, "")}](${encodeURI(file)})`).join("\n");
  return `---
type: Index
title: OKF Bundle Index
description: Strict OKF export generated from OKF Obsidian Memory.
tags:
  - okf
timestamp: ${new Date().toISOString()}
okf_spec_version: "${OKF_SPEC_VERSION}"
---

# OKF Bundle Index

${rows || "No concept files exported."}
`;
}

function renderOkfLog(files) {
  return `---
type: Log
title: OKF Export Log
description: Export metadata for this OKF bundle.
tags:
  - okf
timestamp: ${new Date().toISOString()}
okf_spec_version: "${OKF_SPEC_VERSION}"
---

# Export Log

- Exported files: ${files.length}
- Generated: ${new Date().toISOString()}
`;
}

async function collectMarkdownFiles(root) {
  const files = [];
  async function visit(dir) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(full);
      }
    }
  }
  await visit(root);
  return files;
}

function parseMarkdownWithFrontmatter(raw) {
  const text = String(raw || "");
  if (!text.startsWith("---\n")) return { frontmatter: false, data: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: false, data: {}, body: text };
  return {
    frontmatter: true,
    ...parseFrontmatter(text.slice(4, end)),
    body: text.slice(end + 5)
  };
}

function parseFrontmatter(text) {
  try {
    const document = parseDocument(String(text || ""), { merge: true, maxAliasCount: 100, prettyErrors: false });
    const parsed = document.toJS({ maxAliasCount: 100 });
    return {
      data: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
      errors: document.errors.map((item) => item.message)
    };
  } catch (error) {
    return { data: {}, errors: [error.message] };
  }
}

function renderFrontmatter(data) {
  const yaml = stringifyYaml(data, {
    lineWidth: 0,
    defaultStringType: "QUOTE_SINGLE",
    defaultKeyType: "PLAIN"
  }).trimEnd();
  return `---\n${yaml}\n---`;
}

function normalizeResource(resource, vault) {
  const text = String(resource || "");
  if (/^(https?|file):/i.test(text) || text === "inline-input") return text;
  const normalized = text.replaceAll("\\", "/");
  if (path.isAbsolute(text)) return `file:///${normalized.replace(/^([A-Za-z]):/, "$1:")}`;
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function issue(code, file, message) {
  return { code, file, message };
}
