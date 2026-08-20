import path from "node:path";
import { access, mkdir, readFile } from "node:fs/promises";
import { atomicWriteJson } from "./fsSafe.js";

const DEFAULT_CONFIG = {
  notesDir: "concepts",
  dailyDir: "daily",
  sourcesDir: "sources",
  entitiesDir: "entities",
  synthesesDir: "syntheses",
  cacheDir: ".okf-cache",
  supportedTextTypes: ["txt", "md", "markdown", "json", "csv", "html", "htm", "xml", "log"]
};

export async function loadConfig(vault) {
  const configPath = path.join(vault, "okf-obsidian.config.json");
  try {
    const raw = await readFile(configPath, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw), configPath };
  } catch {
    return { ...DEFAULT_CONFIG, configPath };
  }
}

export async function ensureConfig(vault) {
  const configPath = path.join(vault, "okf-obsidian.config.json");
  await mkdir(vault, { recursive: true });
  try {
    await access(configPath);
    return configPath;
  } catch {
    try {
      await atomicWriteJson(configPath, DEFAULT_CONFIG);
      return configPath;
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EEXIST") {
        try {
          await access(configPath);
          return configPath;
        } catch {
          // The competing writer did not finish successfully; preserve the original error.
        }
      }
      throw error;
    }
  }
}

export function getDefaultConfig() {
  return structuredClone(DEFAULT_CONFIG);
}
