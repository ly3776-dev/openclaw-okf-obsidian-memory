import path from "node:path";

const inputPath = process.argv.at(-1) || "mock.txt";
const extension = path.extname(inputPath).toLowerCase();
const sourceType = extension === ".pdf"
  ? "pdf"
  : [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)
    ? "image"
    : [".mp3", ".wav", ".m4a"].includes(extension)
      ? "audio"
      : "video";
const textByType = {
  image: "OpenClaw OKF Obsidian Memory mocked OCR content.",
  pdf: "OpenClaw PDF OCR fallback verification mocked content.",
  audio: "OpenClaw audio memory test mocked transcription.",
  video: "Douyin OpenClaw video memory test mocked transcription."
};

process.stdout.write(JSON.stringify({
  text: textByType[sourceType],
  title: `mock-${sourceType}`,
  source_type: sourceType,
  warnings: ["unit-test mock extractor"]
}));
