import { spawn } from "node:child_process";

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 500;

export class ProcessExecutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = details.timedOut ? "ProcessTimeoutError" : "ProcessExecutionError";
    Object.assign(this, details);
  }
}

export async function runProcess(command, args = [], options = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs, 20_000);
  const maxBuffer = positiveInteger(options.maxBuffer, DEFAULT_MAX_BUFFER);
  const killGraceMs = positiveInteger(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
  const stage = options.stage || "external process";
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let aborting = false;

    const timer = setTimeout(() => {
      abort(new ProcessExecutionError(
        `${stage} exceeded ${timeoutMs}ms; its process tree was terminated. / ${stage} 超过 ${timeoutMs}ms，已终止整个进程树。`,
        { code: "PROCESS_TIMEOUT", command, args, stage, timeoutMs, timedOut: true }
      ));
    }, timeoutMs);

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const abort = async (error) => {
      if (settled || aborting) return;
      aborting = true;
      await terminateProcessTree(child, { killGraceMs });
      error.stdout = Buffer.concat(stdout).toString(options.encoding || "utf8");
      error.stderr = Buffer.concat(stderr).toString(options.encoding || "utf8");
      error.durationMs = Date.now() - startedAt;
      finish(reject, error);
    };

    child.once("error", (error) => {
      finish(reject, new ProcessExecutionError(
        `${stage} could not start: ${error.message} / ${stage} 无法启动：${error.message}`,
        { code: error.code || "PROCESS_START_FAILED", command, args, stage, timeoutMs, cause: error }
      ));
    });

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        abort(bufferLimitError(stage, command, args, maxBuffer, "stdout"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        abort(bufferLimitError(stage, command, args, maxBuffer, "stderr"));
        return;
      }
      stderr.push(chunk);
    });

    child.once("close", (exitCode, signal) => {
      if (aborting || settled) return;
      const result = {
        command,
        args,
        stage,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString(options.encoding || "utf8"),
        stderr: Buffer.concat(stderr).toString(options.encoding || "utf8"),
        durationMs: Date.now() - startedAt
      };
      if (exitCode === 0) {
        finish(resolve, result);
      } else {
        finish(reject, new ProcessExecutionError(
          `${stage} exited with code ${exitCode ?? "unknown"}${signal ? ` (${signal})` : ""}. / ${stage} 异常退出，代码 ${exitCode ?? "未知"}${signal ? `（${signal}）` : ""}。`,
          { ...result, code: "PROCESS_EXIT_FAILED", timeoutMs }
        ));
      }
    });
  });
}

export async function terminateProcessTree(child, { killGraceMs = DEFAULT_KILL_GRACE_MS } = {}) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await runTaskkill(child.pid);
    try { child.kill("SIGKILL"); } catch {}
    return;
  }

  try { process.kill(-child.pid, "SIGTERM"); } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  await delay(killGraceMs);
  if (isProcessGroupAlive(child.pid)) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    const timer = setTimeout(() => {
      try { killer.kill("SIGKILL"); } catch {}
      resolve();
    }, 5_000);
    killer.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
    killer.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function bufferLimitError(stage, command, args, maxBuffer, stream) {
  return new ProcessExecutionError(
    `${stage} exceeded the ${stream} limit (${maxBuffer} bytes); its process tree was terminated. / ${stage} 超过 ${stream} 输出上限（${maxBuffer} 字节），已终止整个进程树。`,
    { code: "PROCESS_MAX_BUFFER", command, args, stage, maxBuffer, stream }
  );
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
