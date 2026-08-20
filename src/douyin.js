import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runProcess } from "./process.js";
import { resolvePythonExecutable } from "./python.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOWNLOADER_SCRIPT = path.resolve(__dirname, "..", "scripts", "douyin_download.py");
export const DEFAULT_DOUYIN_TIMEOUT_MS = 180_000;

export async function downloadDouyin({ input, outputDir = "downloads" } = {}) {
  if (!input || !String(input).trim()) {
    throw new Error("downloadDouyin requires a Douyin URL or share text");
  }
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `douyin-${Date.now()}.mp4`);
  const python = resolvePythonExecutable();
  const script = process.env.OKF_DOUYIN_DOWNLOADER_SCRIPT || DEFAULT_DOWNLOADER_SCRIPT;
  let result;
  try {
    result = await runProcess(python, [script, input, outputPath], {
      stage: "Douyin download",
      timeoutMs: timeoutFromEnv("OKF_DOUYIN_TIMEOUT_MS", DEFAULT_DOUYIN_TIMEOUT_MS),
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    const wrapped = new Error(`Douyin download failed: ${error.message} Retry after checking network access, or download the media manually. / 抖音下载失败：${error.message} 请检查网络后重试，或手动下载媒体。`);
    wrapped.code = error.code || "DOUYIN_DOWNLOAD_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
  return {
    ok: true,
    filePath: outputPath,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export function looksLikeDouyin(text) {
  return /douyin\.com|v\.douyin\.com/i.test(String(text || ""));
}

function timeoutFromEnv(key, fallback) {
  const parsed = Number.parseInt(String(process.env[key] || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
