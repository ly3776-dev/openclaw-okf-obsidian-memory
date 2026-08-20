#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { atomicWriteFile } from "../src/fsSafe.js";

const [targetPath, readyPath] = process.argv.slice(2);
if (!targetPath || !readyPath) throw new Error("targetPath and readyPath are required");

await atomicWriteFile(targetPath, '{"generation":"interrupted"}\n', {
  encoding: "utf8",
  beforeRename: async (tempPath) => {
    await writeFile(readyPath, `${JSON.stringify({ pid: process.pid, tempPath })}\n`, "utf8");
    await new Promise(() => setInterval(() => {}, 1_000));
  }
});
