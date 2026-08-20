import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runProcess } from "./process.js";
import { resolvePythonExecutable } from "./python.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, "..", "scripts");

export const DEFAULT_EXTRACTOR_TIMEOUTS = Object.freeze({
  probe: 20_000,
  ocr: 180_000,
  pdf: 180_000,
  transcription: 600_000
});

const EXTENSION_MAP = new Map([
  [".txt", "text"],
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".json", "json"],
  [".csv", "csv"],
  [".html", "html"],
  [".htm", "html"],
  [".xml", "xml"],
  [".log", "text"],
  [".png", "image"],
  [".jpg", "image"],
  [".jpeg", "image"],
  [".webp", "image"],
  [".gif", "image"],
  [".pdf", "pdf"],
  [".mp3", "audio"],
  [".wav", "audio"],
  [".m4a", "audio"],
  [".mp4", "video"],
  [".mov", "video"],
  [".mkv", "video"]
]);

export async function extractInput({ text, inputPath, sourceType = "auto" } = {}) {
  if (text && String(text).trim()) {
    return {
      text: normalizeText(text),
      sourceType: sourceType === "auto" ? "text" : sourceType,
      inputPath: inputPath || null,
      title: null,
      warnings: []
    };
  }

  if (!inputPath) {
    throw new Error("ingest requires either --text or --input");
  }

  const detectedType = sourceType === "auto" ? detectSourceType(inputPath) : sourceType;
  if (["pdf", "image", "audio", "video"].includes(detectedType)) {
    return extractRichMedia(inputPath, detectedType);
  }

  const raw = await readFile(inputPath, "utf8");
  const extracted = normalizeExtractedContent(raw, detectedType, inputPath);
  return {
    text: extracted.text,
    sourceType: detectedType,
    inputPath,
    title: extracted.title,
    warnings: []
  };
}

export function detectSourceType(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  return EXTENSION_MAP.get(ext) || "text";
}

export async function runExtractorDoctor({ run = runProcess } = {}) {
  const python = resolvePythonExecutable();
  const checks = {};
  checks.markitdown = await probePythonModule(run, python, "markitdown");
  checks.paddleocr = await probePythonModule(run, python, "paddleocr");
  checks.fasterWhisper = await probePythonModule(run, python, "faster_whisper");
  checks.funasr = await probePythonModule(run, python, "funasr");
  const available = Object.entries(checks).filter(([, value]) => !String(value).startsWith("missing:"));
  const missing = Object.entries(checks).filter(([, value]) => String(value).startsWith("missing:"));
  return {
    ok: true,
    ready: missing.length === 0,
    python,
    available: available.map(([name]) => name),
    missing: missing.map(([name]) => name),
    whisperModel: process.env.OKF_WHISPER_MODEL_PATH || process.env.OKF_WHISPER_MODEL || "tiny",
    modelDownloadPolicy: process.env.OKF_ALLOW_MODEL_DOWNLOAD === "1" ? "doctor_or_install_allowed" : "ingest_local_only",
    modelDownloadPolicyZh: process.env.OKF_ALLOW_MODEL_DOWNLOAD === "1" ? "仅 doctor 或安装阶段允许下载" : "正式 ingest 仅使用本地模型",
    timeouts: extractorTimeouts(),
    repairs: {
      en: "Create .venv and run: .venv Python -m pip install -r requirements.txt",
      zh: "创建 .venv 后运行：.venv 中的 Python -m pip install -r requirements.txt"
    },
    ...checks
  };
}

async function probePythonModule(run, python, moduleName) {
  try {
    const { stdout } = await run(python, ["-c", `import ${moduleName}; print(${moduleName}.__name__)`], {
      stage: `environment probe: ${moduleName}`,
      timeoutMs: timeoutFromEnv("OKF_PROBE_TIMEOUT_MS", DEFAULT_EXTRACTOR_TIMEOUTS.probe),
      maxBuffer: 1024 * 1024
    });
    return stdout.trim() || moduleName;
  } catch (error) {
    return `missing: ${formatProcessFailure(error)}`;
  }
}

function normalizeExtractedContent(raw, sourceType, inputPath) {
  if (sourceType === "markdown" || sourceType === "text" || sourceType === "log") return { text: normalizeText(raw), title: null };
  if (sourceType === "json") return normalizeJson(raw, inputPath);
  if (sourceType === "csv") return { text: normalizeCsv(raw), title: null };
  if (sourceType === "html" || sourceType === "xml") return { text: stripMarkup(raw), title: extractHtmlTitle(raw) };
  return { text: normalizeText(raw), title: null };
}

function normalizeJson(raw, inputPath) {
  try {
    const parsed = JSON.parse(raw);
    const title = pickJsonTitle(parsed) || path.basename(inputPath);
    return {
      text: `${title}. ${jsonToReadableText(parsed)}\n\nRaw JSON:\n${JSON.stringify(parsed, null, 2)}`,
      title
    };
  } catch {
    return { text: normalizeText(raw), title: null };
  }
}

function normalizeCsv(raw) {
  const rows = normalizeText(raw).split("\n").filter(Boolean);
  return rows.slice(0, 40).join("\n");
}

function stripMarkup(raw) {
  return normalizeText(
    String(raw || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
  );
}

function pickJsonTitle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of ["title", "topic", "name", "headline", "subject"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return null;
}

function jsonToReadableText(value) {
  if (!value || typeof value !== "object") return String(value ?? "");
  if (Array.isArray(value)) return value.map((item) => jsonToReadableText(item)).join("\n");
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${cleanJsonValue(item)}`)
    .join(". ");
}

function cleanJsonValue(value) {
  const text = Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  return text.replace(/[.。]+$/u, "");
}

function extractHtmlTitle(raw) {
  const match = String(raw || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripMarkup(match[1]) : null;
}

async function extractRichMedia(inputPath, detectedType) {
  const python = resolvePythonExecutable({ override: process.env.OKF_EXTRACTOR_EXECUTABLE });
  const failures = [];
  const transcript = await tryTranscription(inputPath, detectedType, python);
  if (transcript.ok) return transcript.value;
  if (transcript.error) failures.push(transcript.error);
  const preferred = await tryPaddleOcr(inputPath, detectedType, python);
  if (preferred.ok) return preferred.value;
  if (preferred.error) failures.push(preferred.error);
  try {
    const script = extractorScript("OKF_MARKITDOWN_SCRIPT", "markitdown_extract.py");
    const { stdout } = await runProcess(python, [script, inputPath], {
      stage: `${detectedType} extraction: MarkItDown`,
      timeoutMs: mediaTimeout(detectedType),
      maxBuffer: 10 * 1024 * 1024
    });
    const parsed = parseToolJson(stdout);
    const extractedText = String(parsed.text || "").trim();
    if (!extractedText) {
      throw new Error(`MarkItDown returned no text for ${detectedType}. Install or configure OCR/transcription support, or provide a text transcript alongside the file.`);
    }
    return {
      text: extractedText,
      title: parsed.title || null,
      sourceType: parsed.source_type || detectedType,
      inputPath,
      warnings: [...failures.map((item) => item.message), ...(parsed.warnings || [])]
    };
  } catch (error) {
    failures.push({ stage: "MarkItDown", message: formatProcessFailure(error) });
    throw extractionFailure(detectedType, failures);
  }
}

async function tryTranscription(inputPath, detectedType, python) {
  if (detectedType !== "audio" && detectedType !== "video") return { ok: false };
  if (process.env.OKF_OBSIDIAN_DISABLE_TRANSCRIPTION === "1") return { ok: false };
  try {
    const script = extractorScript("OKF_TRANSCRIBE_SCRIPT", "transcribe_media.py");
    const { stdout } = await runProcess(python, [script, inputPath], {
      stage: `${detectedType} transcription: model load and processing`,
      timeoutMs: timeoutFromEnv("OKF_TRANSCRIPTION_TIMEOUT_MS", DEFAULT_EXTRACTOR_TIMEOUTS.transcription),
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        OKF_ALLOW_MODEL_DOWNLOAD: "0"
      }
    });
    const parsed = parseToolJson(stdout);
    const text = String(parsed.text || "").trim();
    if (!text) return { ok: false };
    return {
      ok: true,
      value: {
        text,
        title: parsed.title || null,
        sourceType: parsed.source_type || detectedType,
        inputPath,
        warnings: parsed.warnings || []
      }
    };
  } catch (error) {
    return { ok: false, error: { stage: "transcription", message: formatProcessFailure(error) } };
  }
}

async function tryPaddleOcr(inputPath, detectedType, python) {
  if (detectedType !== "image" && detectedType !== "pdf") return { ok: false };
  if (process.env.OKF_OBSIDIAN_DISABLE_PADDLEOCR === "1") return { ok: false };
  try {
    const script = extractorScript("OKF_PADDLEOCR_SCRIPT", "paddleocr_extract.py");
    const { stdout } = await runProcess(python, [script, inputPath], {
      stage: `${detectedType} extraction: PaddleOCR model load and processing`,
      timeoutMs: mediaTimeout(detectedType),
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT: process.env.PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT || "0"
      }
    });
    const parsed = parseToolJson(stdout);
    const text = String(parsed.text || "").trim();
    if (!text) return { ok: false };
    return {
      ok: true,
      value: {
        text,
        title: parsed.title || null,
        sourceType: parsed.source_type || detectedType,
        inputPath,
        warnings: parsed.warnings || []
      }
    };
  } catch (error) {
    return { ok: false, error: { stage: "PaddleOCR", message: formatProcessFailure(error) } };
  }
}

function extractorScript(environmentKey, filename) {
  return process.env[environmentKey] || path.join(SCRIPTS_DIR, filename);
}

function extractorTimeouts() {
  return {
    probeMs: timeoutFromEnv("OKF_PROBE_TIMEOUT_MS", DEFAULT_EXTRACTOR_TIMEOUTS.probe),
    ocrMs: timeoutFromEnv("OKF_OCR_TIMEOUT_MS", DEFAULT_EXTRACTOR_TIMEOUTS.ocr),
    pdfMs: timeoutFromEnv("OKF_PDF_TIMEOUT_MS", DEFAULT_EXTRACTOR_TIMEOUTS.pdf),
    transcriptionMs: timeoutFromEnv("OKF_TRANSCRIPTION_TIMEOUT_MS", DEFAULT_EXTRACTOR_TIMEOUTS.transcription)
  };
}

function mediaTimeout(detectedType) {
  return detectedType === "pdf"
    ? timeoutFromEnv("OKF_PDF_TIMEOUT_MS", DEFAULT_EXTRACTOR_TIMEOUTS.pdf)
    : timeoutFromEnv("OKF_OCR_TIMEOUT_MS", DEFAULT_EXTRACTOR_TIMEOUTS.ocr);
}

function timeoutFromEnv(key, fallback) {
  const parsed = Number.parseInt(String(process.env[key] || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatProcessFailure(error) {
  const detail = String(error?.stderr || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
  return `${error?.message || String(error)}${detail ? `; detail: ${detail}` : ""}`;
}

function extractionFailure(detectedType, failures) {
  const attempts = failures.map((failure) => `${failure.stage}: ${failure.message}`).join("; ");
  const suggestion = detectedType === "audio" || detectedType === "video"
    ? "Run doctor/model preparation first, configure a local FunASR or Faster-Whisper model, or provide a transcript. / 请先运行 doctor/模型预下载，配置本地 FunASR 或 Faster-Whisper 模型，或提供文字稿。"
    : "Run doctor to verify PaddleOCR and MarkItDown, or provide a text/OCR companion file. / 请运行 doctor 检查 PaddleOCR 与 MarkItDown，或提供文字/OCR 文件。";
  const error = new Error(`Failed to extract ${detectedType}. ${attempts}. ${suggestion}`);
  error.code = "RICH_MEDIA_EXTRACTION_FAILED";
  error.failures = failures;
  return error;
}

function normalizeText(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function parseToolJson(output) {
  const text = String(output || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Extractor did not return JSON");
  }
}
