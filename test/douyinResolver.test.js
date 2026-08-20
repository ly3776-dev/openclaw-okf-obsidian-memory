import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  isOfficialProgressiveUrl,
  parseDetailResponse,
  selectProgressiveUrls
} from "../scripts/douyin_browser_resolve.js";

const execFileAsync = promisify(execFile);
const fixturePath = path.resolve("test/fixtures/douyin_detail_7672739841457563897.json");

test("official Douyin detail fixture yields progressive MP4 fallbacks", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const result = parseDetailResponse(fixture, "7672739841457563897");

  assert.equal(result.source, "douyin-official-browser-api");
  assert.equal(result.duration_ms, 204667);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.equal(result.play_urls.length, 3);
  assert.match(result.play_url, /^https:\/\/v11-weba\.douyinvod\.com\//);
  assert.deepEqual(selectProgressiveUrls(fixture.aweme_detail.video), result.play_urls);
});

test("resolver rejects third-party, non-HTTPS, and DASH-only URLs", () => {
  assert.equal(isOfficialProgressiveUrl("https://example.com/video.mp4"), false);
  assert.equal(isOfficialProgressiveUrl("http://v11-weba.douyinvod.com/video.mp4"), false);
  assert.equal(isOfficialProgressiveUrl("https://v11-weba.douyinvod.com/media-video-avc1/video.mp4"), false);
  assert.equal(isOfficialProgressiveUrl("https://v26-web.douyinvod.com/video.mp4"), true);
});

test("prepared OpenClaw plugin includes and can load both Douyin runtime scripts", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/prepare_openclaw_plugin.js", "--print-path"], {
    cwd: process.cwd(),
    windowsHide: true
  });
  const target = stdout.trim();
  const pythonDownloader = path.join(target, "scripts", "douyin_download.py");
  const browserResolver = path.join(target, "scripts", "douyin_browser_resolve.js");

  assert.equal(existsSync(pythonDownloader), true, "prepared plugin omitted douyin_download.py");
  assert.equal(existsSync(browserResolver), true, "prepared plugin omitted douyin_browser_resolve.js");
  assert.match(await readFile(pythonDownloader, "utf8"), /get_browser_play_urls/);

  const installedModule = await import(`${pathToFileURL(browserResolver).href}?test=${Date.now()}`);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(installedModule.parseDetailResponse(fixture, "7672739841457563897").play_urls.length, 3);
});
