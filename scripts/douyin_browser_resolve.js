#!/usr/bin/env node
/**
 * Resolve current Douyin video metadata through Douyin's own web page.
 *
 * Douyin signs its detail API in browser JavaScript. This helper lets the
 * official page generate that signature, captures the official response, and
 * returns a progressive MP4 URL. It does not send the shared URL to a third
 * party resolver.
 */

import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire, globalPaths } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 75_000;
const DETAIL_PATH = "/aweme/v1/web/aweme/detail/";
const OFFICIAL_VIDEO_HOST_SUFFIXES = [
  ".douyinvod.com",
  ".douyin.com",
  ".snssdk.com"
];

export function parseDetailResponse(payload, expectedVideoId) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Douyin detail API returned an invalid response");
  }
  if (Number(payload.status_code || 0) !== 0) {
    throw new Error(`Douyin detail API returned status_code=${payload.status_code}`);
  }

  const detail = payload.aweme_detail;
  if (!detail || typeof detail !== "object") {
    throw new Error("Douyin detail API did not return aweme_detail");
  }
  const videoId = String(detail.aweme_id || "");
  if (expectedVideoId && videoId !== String(expectedVideoId)) {
    throw new Error(`Douyin detail video id mismatch: expected ${expectedVideoId}, got ${videoId || "empty"}`);
  }

  const playUrls = selectProgressiveUrls(detail.video);
  if (!playUrls.length) {
    throw new Error(`No progressive MP4 URL found; aweme_type=${detail.aweme_type}. Image posts are not supported.`);
  }

  return {
    ok: true,
    source: "douyin-official-browser-api",
    video_id: videoId,
    title: String(detail.desc || videoId).slice(0, 200),
    play_url: playUrls[0],
    play_urls: playUrls,
    duration_ms: finiteNumber(detail.video?.duration),
    width: finiteNumber(detail.video?.width),
    height: finiteNumber(detail.video?.height)
  };
}

export function selectProgressiveUrl(video) {
  return selectProgressiveUrls(video)[0] || null;
}

export function selectProgressiveUrls(video) {
  const groups = [
    video?.play_addr_h264?.url_list,
    video?.play_addr?.url_list,
    video?.play_addr_265?.url_list
  ];

  const result = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const candidate of group) {
      if (isOfficialProgressiveUrl(candidate) && !result.includes(candidate)) result.push(candidate);
    }
  }
  return result;
}

export function isOfficialProgressiveUrl(candidate) {
  try {
    const url = new URL(String(candidate));
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    const official = OFFICIAL_VIDEO_HOST_SUFFIXES.some((suffix) =>
      hostname === suffix.slice(1) || hostname.endsWith(suffix)
    );
    if (!official) return false;
    return !/\/media-(?:video|audio)-/i.test(url.pathname);
  } catch {
    return false;
  }
}

export async function resolveDouyinVideo(videoId, options = {}) {
  if (!/^\d{10,25}$/.test(String(videoId || ""))) {
    throw new Error(`Invalid Douyin video id: ${videoId || "empty"}`);
  }

  const timeoutMs = positiveInteger(options.timeoutMs || process.env.OKF_DOUYIN_BROWSER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const playwright = loadPlaywrightCore();
  const executablePath = options.executablePath || resolveBrowserExecutable(playwright.chromium);
  const launchArgs = ["--disable-blink-features=AutomationControlled", "--no-first-run"];
  if (process.platform === "linux") launchArgs.push("--disable-dev-shm-usage");
  if (typeof process.getuid === "function" && process.getuid() === 0) launchArgs.push("--no-sandbox");

  let browser;
  try {
    browser = await playwright.chromium.launch({
      executablePath,
      headless: !truthy(process.env.OKF_DOUYIN_BROWSER_VISIBLE),
      args: launchArgs
    });
    const version = browser.version();
    const context = await browser.newContext({
      locale: "zh-CN",
      userAgent: desktopChromeUserAgent(version),
      viewport: { width: 1280, height: 800 }
    });
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();
    const responsePromise = page.waitForResponse((response) => {
      if (response.status() !== 200 || !response.url().includes(DETAIL_PATH)) return false;
      try {
        return new URL(response.url()).searchParams.get("aweme_id") === String(videoId);
      } catch {
        return false;
      }
    }, { timeout: timeoutMs });

    const navigation = page.goto(`https://www.douyin.com/video/${videoId}`, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs
    }).catch((error) => error);
    const response = await responsePromise;
    const payload = await response.json();
    await navigation;
    return {
      ...parseDetailResponse(payload, videoId),
      browser: path.basename(executablePath)
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

export function resolveBrowserExecutable(chromium) {
  const explicit = process.env.OKF_DOUYIN_BROWSER_EXECUTABLE;
  if (explicit) {
    if (!isExecutableFile(explicit)) {
      throw new Error(`OKF_DOUYIN_BROWSER_EXECUTABLE does not exist or is not executable: ${explicit}`);
    }
    return explicit;
  }

  const candidates = [];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // A system browser can still be used when the Playwright-managed one is absent.
  }
  candidates.push(...systemBrowserCandidates());
  for (const cacheRoot of playwrightCacheRoots()) {
    candidates.push(...cachedBrowserCandidates(cacheRoot));
  }
  const found = candidates.find((candidate) => isExecutableFile(candidate));
  if (found) return found;

  throw new Error(
    "No Chromium browser found. Install Chrome/Edge/Chromium, run Playwright's chromium install, " +
    "or set OKF_DOUYIN_BROWSER_EXECUTABLE to the browser executable."
  );
}

function loadPlaywrightCore() {
  const rootRequire = createRequire(import.meta.url);
  const explicit = process.env.OKF_DOUYIN_PLAYWRIGHT_CORE_PATH;
  if (explicit) {
    try {
      return rootRequire(explicit);
    } catch (error) {
      throw new Error(`OKF_DOUYIN_PLAYWRIGHT_CORE_PATH could not be loaded: ${explicit} (${error.message})`);
    }
  }
  try {
    return rootRequire("playwright-core");
  } catch {
    // ClawHub skills are not necessarily stored below OpenClaw's node_modules.
  }

  for (const openClawRoot of candidateOpenClawRoots(rootRequire)) {
    try {
      return createRequire(path.join(openClawRoot, "package.json"))("playwright-core");
    } catch {
      // Try the next local or global OpenClaw installation.
    }
  }

  for (const moduleRoot of globalPaths) {
    try {
      return createRequire(path.join(moduleRoot, "__okf_resolver__.js"))("playwright-core");
    } catch {
      // Continue through Node's global module roots.
    }
  }

  throw new Error(
    "playwright-core is unavailable. Install OpenClaw/OKF dependencies, or set " +
    "OKF_DOUYIN_PLAYWRIGHT_CORE_PATH to the playwright-core package directory."
  );
}

function candidateOpenClawRoots(rootRequire) {
  const candidates = [];
  try {
    candidates.push(findPackageRoot(rootRequire.resolve("openclaw"), "openclaw"));
  } catch {
    // Search known local/global layouts below.
  }

  for (const start of [process.cwd(), path.dirname(fileURLToPath(import.meta.url))]) {
    let current = path.resolve(start);
    for (let depth = 0; depth < 10; depth += 1) {
      candidates.push(path.join(current, "node_modules", "openclaw"));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  for (const moduleRoot of globalPaths) candidates.push(path.join(moduleRoot, "openclaw"));
  for (const moduleRoot of String(process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(moduleRoot, "openclaw"));
  }
  if (process.platform === "win32") {
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "openclaw"));
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "npm", "node_modules", "openclaw"));
  } else {
    candidates.push(
      "/usr/local/lib/node_modules/openclaw",
      "/usr/lib/node_modules/openclaw",
      path.join(os.homedir(), ".npm-global", "lib", "node_modules", "openclaw")
    );
  }

  return [...new Set(candidates)].filter(isOpenClawPackageRoot);
}

function isOpenClawPackageRoot(directory) {
  const manifest = path.join(directory, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).name === "openclaw";
  } catch {
    return false;
  }
}

function findPackageRoot(entryPath, expectedName) {
  let current = path.dirname(entryPath);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = path.join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, "utf8")).name === expectedName) return current;
      } catch {
        // Keep walking if an unrelated package.json is invalid.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate the ${expectedName} package root`);
}

function systemBrowserCandidates() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium"
  ];
}

function playwrightCacheRoots() {
  const explicit = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (explicit && explicit !== "0") return [explicit];
  if (process.platform === "win32") {
    return [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright")];
  }
  if (process.platform === "darwin") return [path.join(os.homedir(), "Library", "Caches", "ms-playwright")];
  return [path.join(os.homedir(), ".cache", "ms-playwright")];
}

function cachedBrowserCandidates(cacheRoot) {
  if (!cacheRoot || !existsSync(cacheRoot)) return [];
  const result = [];
  for (const directory of safeReadDir(cacheRoot)) {
    if (!/^(chromium|chromium_headless_shell)-\d+$/i.test(directory.name) || !directory.isDirectory()) continue;
    const base = path.join(cacheRoot, directory.name);
    const relativeCandidates = process.platform === "win32"
      ? ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-headless-shell-win64/headless_shell.exe"]
      : process.platform === "darwin"
        ? ["chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"]
        : ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-headless-shell-linux64/headless_shell"];
    for (const relative of relativeCandidates) result.push(path.join(base, ...relative.split("/")));
  }
  return result.sort().reverse();
}

function safeReadDir(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isExecutableFile(filePath) {
  if (!filePath || !existsSync(filePath)) return false;
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function desktopChromeUserAgent(version) {
  const major = String(version || "124").match(/^\d+/)?.[0] || "124";
  if (process.platform === "darwin") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  if (process.platform === "linux") {
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function finiteNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

async function main() {
  const videoId = process.argv[2];
  if (!videoId) {
    console.error("Usage: node douyin_browser_resolve.js <video-id>");
    process.exitCode = 2;
    return;
  }
  try {
    console.log(JSON.stringify(await resolveDouyinVideo(videoId)));
  } catch (error) {
    console.error(`Douyin browser resolver failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
