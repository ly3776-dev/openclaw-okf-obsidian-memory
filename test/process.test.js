import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../src/process.js";
import { resolvePythonExecutable } from "../src/python.js";

test("runProcess times out and terminates the full process tree", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "okf-process-tree-"));
  const pidFile = path.join(tempDir, "child.pid");
  const python = resolvePythonExecutable();
  try {
    await assert.rejects(
      runProcess(python, [path.resolve("test/fixtures/hang_process_tree.py"), pidFile], {
        stage: "mock hung Python extractor",
        timeoutMs: 300,
        killGraceMs: 50
      }),
      (error) => error.code === "PROCESS_TIMEOUT" && error.timedOut === true && /进程树/.test(error.message)
    );
    const childPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.equal(await waitUntilGone(childPid, 2_000), true, `child process ${childPid} survived timeout cleanup`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function waitUntilGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
