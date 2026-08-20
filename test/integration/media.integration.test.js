import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ingest } from "../../src/core.js";
import { runProcess } from "../../src/process.js";

const MEDIA_TEST_TIMEOUT_MS = 700_000;

test("real image integration uses PaddleOCR", { timeout: MEDIA_TEST_TIMEOUT_MS }, async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-image-integration-"));
  try {
    const result = await ingest({ vault, inputPath: path.resolve("examples/sample-image.png") });
    assert.equal(result.ok, true);
    assert.equal(result.sourceType, "image");
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("real PDF integration uses MarkItDown fallback", { timeout: MEDIA_TEST_TIMEOUT_MS }, async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-pdf-integration-"));
  const previous = process.env.OKF_OBSIDIAN_DISABLE_PADDLEOCR;
  process.env.OKF_OBSIDIAN_DISABLE_PADDLEOCR = "1";
  try {
    const result = await ingest({ vault, inputPath: path.resolve("examples/sample-pdf.pdf") });
    assert.equal(result.ok, true);
    assert.equal(result.sourceType, "pdf");
  } finally {
    restoreEnv("OKF_OBSIDIAN_DISABLE_PADDLEOCR", previous);
    await rm(vault, { recursive: true, force: true });
  }
});

test("real audio integration uses a local transcription model", { timeout: MEDIA_TEST_TIMEOUT_MS }, async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-audio-integration-"));
  const wav = path.join(vault, "speech.wav");
  try {
    await makeAudioFixture(wav);
    const result = await ingest({ vault, inputPath: wav });
    assert.equal(result.ok, true);
    assert.equal(result.sourceType, "audio");
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("real video integration uses a local transcription model", { timeout: MEDIA_TEST_TIMEOUT_MS }, async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "okf-video-integration-"));
  const mp4 = path.join(vault, "speech.mp4");
  try {
    await makeVideoFixture(mp4);
    const result = await ingest({ vault, inputPath: mp4 });
    assert.equal(result.ok, true);
    assert.equal(result.sourceType, "video");
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

async function makeAudioFixture(outputPath) {
  await runProcess("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "flite=text='open claw obsidian memory test':voice=kal",
    "-t", "3", outputPath
  ], { stage: "integration FFmpeg audio fixture", timeoutMs: 30_000, maxBuffer: 4 * 1024 * 1024 });
}

async function makeVideoFixture(outputPath) {
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=black:size=320x180:duration=3",
    "-f", "lavfi", "-i", "flite=text='open claw video memory test':voice=kal",
    "-shortest", "-pix_fmt", "yuv420p", outputPath
  ], { stage: "integration FFmpeg video fixture", timeoutMs: 30_000, maxBuffer: 4 * 1024 * 1024 });
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
