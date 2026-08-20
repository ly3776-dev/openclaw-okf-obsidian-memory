#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const issues = [];

const obsidianMain = await readFile("obsidian/main.js", "utf8");
const openclawManifest = JSON.parse(await readFile("openclaw.plugin.json", "utf8"));
const legacyPluginManifest = JSON.parse(await readFile("plugin/plugin.json", "utf8"));
const nativePlugin = await readFile("plugin/native.js", "utf8");
const cli = await readFile("src/cli.js", "utf8");

verifyObsidianI18n(obsidianMain);
verifyOpenClawManifests(openclawManifest, legacyPluginManifest);
verifyNativePluginStrings(nativePlugin);
verifyCliStrings(cli);

const result = {
  ok: issues.length === 0,
  checked: {
    obsidian: "obsidian/main.js",
    openclawManifest: "openclaw.plugin.json",
    legacyPluginManifest: "plugin/plugin.json",
    nativePlugin: "plugin/native.js",
    cli: "src/cli.js"
  },
  issues
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function verifyObsidianI18n(source) {
  const i18n = extractI18n(source);
  if (!i18n) {
    issues.push(issue("obsidian_missing_i18n", "obsidian/main.js", "Could not extract the I18N dictionary."));
    return;
  }

  const zhKeys = new Set(Object.keys(i18n.zh || {}));
  const enKeys = new Set(Object.keys(i18n.en || {}));
  for (const key of zhKeys) {
    if (!enKeys.has(key)) issues.push(issue("obsidian_missing_en_key", key, "Chinese I18N key has no English counterpart."));
  }
  for (const key of enKeys) {
    if (!zhKeys.has(key)) issues.push(issue("obsidian_missing_zh_key", key, "English I18N key has no Chinese counterpart."));
  }

  const usedKeys = new Set();
  for (const match of source.matchAll(/\b(?:t|commandName)\("([^"]+)"\)/g)) {
    usedKeys.add(match[1]);
  }
  for (const key of usedKeys) {
    if (!zhKeys.has(key) || !enKeys.has(key)) {
      issues.push(issue("obsidian_used_key_missing_translation", key, "A rendered Obsidian UI key is missing a translation."));
    }
  }

  const commandRegistrations = [...source.matchAll(/this\.addCommand\(\{[\s\S]*?name:\s*this\.commandName\("([^"]+)"\)/g)];
  if (commandRegistrations.length < 6) {
    issues.push(issue("obsidian_commands_not_bilingual", "obsidian/main.js", "Command palette entries must be registered through commandName()."));
  }

  for (const match of source.matchAll(/\.(setName|setDesc|setButtonText)\("([^"]+)"/g)) {
    issues.push(issue("obsidian_hardcoded_ui_text", match[2], `${match[1]} should use t(...) instead of hard-coded UI text.`));
  }
  for (const match of source.matchAll(/new Notice\("([^"]+)"/g)) {
    issues.push(issue("obsidian_hardcoded_notice", match[1], "Notices should use translated text."));
  }
}

function verifyOpenClawManifests(manifest, legacyManifest) {
  requireBilingual("openclaw.plugin.json:name", manifest.name);
  requireBilingual("openclaw.plugin.json:description", manifest.description);
  for (const tool of legacyManifest.tools || []) {
    requireBilingual(`plugin/plugin.json:${tool.name}:description`, tool.description);
  }
}

function verifyNativePluginStrings(source) {
  for (const match of source.matchAll(/\b(label|description):\s*"([^"]+)"/g)) {
    requireBilingual(`plugin/native.js:${match[1]}`, match[2]);
  }

  for (const match of source.matchAll(/\bname:\s*"([^"]+)"/g)) {
    const value = match[1];
    if (/^okf_obsidian_/.test(value)) continue;
    if (/^[a-z0-9_-]+$/.test(value)) continue;
    requireBilingual("plugin/native.js:name", value);
  }
}

function verifyCliStrings(source) {
  if (!source.includes("Usage: okf-obsidian") || !source.includes("用法：okf-obsidian")) {
    issues.push(issue("cli_usage_not_bilingual", "src/cli.js", "CLI usage help must include English and Chinese."));
  }
  if (!source.includes("Unknown command / 未知命令")) {
    issues.push(issue("cli_unknown_command_not_bilingual", "src/cli.js", "Unknown command error must be bilingual."));
  }
}

function extractI18n(source) {
  const prefix = "const I18N = ";
  const start = source.indexOf(prefix);
  if (start < 0) return null;
  const end = source.indexOf("\n};\n\nmodule.exports", start);
  if (end < 0) return null;
  const objectLiteral = source.slice(start + prefix.length, end + 2);
  return Function(`"use strict"; return (${objectLiteral});`)();
}

function requireBilingual(file, value) {
  const text = String(value || "");
  if (!hasLatin(text) || !hasCjk(text)) {
    issues.push(issue("visible_text_not_bilingual", file, `Expected English and Chinese visible text, got: ${text}`));
  }
}

function hasLatin(value) {
  return /[A-Za-z]/.test(String(value || ""));
}

function hasCjk(value) {
  return /[\u3400-\u9FFF]/.test(String(value || ""));
}

function issue(code, file, message) {
  return { code, file, message };
}
