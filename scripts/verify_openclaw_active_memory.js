#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_QUERY =
  "\u6211\u4e4b\u524d\u90a3\u4e2a\u6296\u97f3\u4e9a\u9a6c\u900a\u8fd0\u8425\u89c6\u9891\u91cc\uff0c\u5e7f\u544a\u590d\u76d8\u548cACOS\u6d6a\u8d39\u8bcd\u662f\u600e\u4e48\u5904\u7406\u7684\uff1f\u4e0d\u8981\u89e3\u91caACOS\u5b9a\u4e49\uff0c\u53ea\u56de\u7b54\u8fd9\u6761\u8bb0\u5fc6\u91cc\u5177\u4f53\u505a\u4e86\u4ec0\u4e48\u3002";

const EXPECTED_PATH_FRAGMENT = "okf-export/8k\u4e9a\u9a6c\u900a\u8fd0\u8425\u7684\u4e00\u5929-codex\u5165\u8111\u7248-1e015f10.md";
const EXPECTED_ANSWER_TERMS = [
  ["amazon ads report", "amazon as report"],
  ["ACOS"],
  ["\u6d6a\u8d39\u8bcd"],
  ["\u52a0\u9884\u7b97"]
];

function parseArgs(argv) {
  const args = {
    url: process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789",
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    sessionKey: process.env.OKF_OPENCLAW_SESSION_KEY || "agent:main:main",
    query: process.env.OKF_OPENCLAW_VERIFY_QUERY || DEFAULT_QUERY,
    timeoutMs: Number(process.env.OKF_OPENCLAW_VERIFY_TIMEOUT_MS || 180000)
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  args.timeoutMs = Number(args.timeoutMs);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = args.token || await readGatewayToken();
  if (!token) {
    throw new Error("Gateway token not provided and not found in ~/.openclaw/openclaw.json");
  }

  const client = new GatewayClient({
    url: args.url,
    token,
    scopes: ["operator.admin", "operator.read", "operator.write"]
  });
  await client.connect();
  try {
    const beforeLogs = await client.request("logs.tail", { limit: 1, maxBytes: 4096 }, 15000).catch(() => null);

    await sendAndWait(client, args.sessionKey, "/verbose on", 60000);
    await sendAndWait(client, args.sessionKey, "/trace on", 60000);
    const verification = await sendAndWait(client, args.sessionKey, args.query, args.timeoutMs);

    const history = await client.request("chat.history", {
      sessionKey: args.sessionKey,
      maxChars: 24000
    }, 30000);
    const allMessages = Array.isArray(history.messages) ? history.messages : [];
    const recentMessages = allMessages.slice(-24);
    const toolEvidence = collectToolEvidence(allMessages);
    const answer = verification.finalText || latestAssistantText(recentMessages);
    const logEvidence = await findActiveMemoryLog(client, beforeLogs?.cursor);
    const memorySearchEvidence = toolEvidence.length
      ? []
      : await runOpenClawMemorySearch(args.query).catch(() => []);
    const combinedEvidence = [...toolEvidence, ...memorySearchEvidence];

    const normalizedAnswer = answer.toLocaleLowerCase();
    const answerOk = EXPECTED_ANSWER_TERMS.every((terms) =>
      terms.some((term) => normalizedAnswer.includes(String(term).toLocaleLowerCase()))
    );
    const memoryHit = combinedEvidence.some((item) => item.path.includes(EXPECTED_PATH_FRAGMENT));
    const vectorHit = combinedEvidence.some((item) => item.path.includes(EXPECTED_PATH_FRAGMENT) && Number(item.vectorScore) > 0.5);
    const activeMemoryOk = logEvidence.some((line) => line.includes("active-memory:") && line.includes("done status=ok"));

    const result = {
      ok: answerOk && memoryHit && vectorHit && activeMemoryOk,
      sessionKey: args.sessionKey,
      answer,
      expectedPath: EXPECTED_PATH_FRAGMENT,
      memoryHit,
      vectorHit,
      activeMemoryOk,
      toolEvidence: toolEvidence.slice(0, 5),
      memorySearchEvidence: memorySearchEvidence.slice(0, 5),
      activeMemoryLogs: logEvidence.filter((line) => line.includes("active-memory:")).slice(-6)
    };

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    client.close();
  }
}

async function readGatewayToken() {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const raw = await readFile(configPath, "utf8").catch(() => "");
  if (!raw) return "";
  const config = JSON.parse(raw);
  return config?.gateway?.auth?.token || "";
}

async function sendAndWait(client, sessionKey, message, timeoutMs) {
  const payload = await client.request("chat.send", {
    sessionKey,
    message,
    idempotencyKey: `okf-active-memory-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    deliver: false,
    timeoutMs
  }, Math.min(timeoutMs + 5000, 70000));
  const runId = payload?.runId;
  if (!runId) throw new Error(`chat.send did not return runId: ${JSON.stringify(payload)}`);
  const finalEvent = await client.waitForChatFinal(runId, timeoutMs);
  return {
    payload,
    finalEvent,
    finalText: parseTextFromMessage(finalEvent?.message)
  };
}

async function findActiveMemoryLog(client, cursor) {
  const params = {
    limit: 240,
    maxBytes: 300000,
    ...(Number.isFinite(cursor) ? { cursor } : {})
  };
  const logs = await client.request("logs.tail", params, 30000).catch(() => null);
  const lines = logs?.lines || [];
  return lines.map((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed.message || line;
    } catch {
      return line;
    }
  });
}

function collectToolEvidence(messages) {
  const evidence = [];
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const text = parseTextFromMessage(message);
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      for (const result of parsed.results || []) {
        if (result?.path) {
          evidence.push({
            path: normalizeSlash(result.path),
            score: result.score,
            vectorScore: result.vectorScore,
            textScore: result.textScore,
            citation: result.citation
          });
        }
      }
      if (parsed.path) {
        evidence.push({
          path: normalizeSlash(parsed.path),
          score: parsed.score,
          vectorScore: parsed.vectorScore,
          textScore: parsed.textScore,
          citation: parsed.citation
        });
      }
    } catch {
      const match = text.match(/"path"\s*:\s*"([^"]+)"/);
      if (match) evidence.push({ path: normalizeSlash(match[1]) });
    }
  }
  return evidence;
}

async function runOpenClawMemorySearch(query) {
  const launch = makeLaunchCommand("openclaw", [
    "memory",
    "search",
    "--query",
    query,
    "--max-results",
    "5",
    "--json"
  ]);
  const { stdout } = await execFileAsync(launch.command, launch.args, {
    cwd: process.cwd(),
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024
  });
  const parsed = JSON.parse(String(stdout || "").trim());
  return (parsed.results || []).filter((result) => result?.path).map((result) => ({
    path: normalizeSlash(result.path),
    score: result.score,
    vectorScore: result.vectorScore,
    textScore: result.textScore,
    citation: result.citation,
    source: "memory_search_fallback"
  }));
}

function makeLaunchCommand(command, args) {
  if (process.platform !== "win32") return { command, args };
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsArg).join(" ")]
  };
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_:/.-]+$/.test(text)) return text;
  return `"${text.replace(/(["^&|<>])/g, "^$1")}"`;
}

function latestAssistantText(messages) {
  for (const message of [...messages].reverse()) {
    if (message.role === "assistant") {
      const text = parseTextFromMessage(message).trim();
      if (text) return text;
    }
  }
  return "";
}

function parseTextFromMessage(message) {
  if (typeof message === "string") return message;
  const content = message?.content ?? message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      return part?.text || "";
    }).join("");
  }
  return "";
}

function normalizeSlash(value) {
  return String(value || "").replace(/\\/g, "/");
}

class GatewayClient {
  constructor({ url, token, scopes }) {
    this.url = url;
    this.token = token;
    this.scopes = scopes;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.ws = null;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    return new Promise((resolve, reject) => {
      const failTimer = setTimeout(() => reject(new Error("Gateway connect timeout")), 20000);
      this.ws.addEventListener("message", async (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === "event" && frame.event === "connect.challenge") {
          try {
            const hello = await this.request("connect", {
              minProtocol: 4,
              maxProtocol: 4,
              client: {
                id: "gateway-client",
                version: "okf-active-memory-verify",
                platform: process.platform,
                mode: "backend"
              },
              role: "operator",
              scopes: this.scopes,
              caps: [],
              commands: [],
              permissions: {},
              auth: { token: this.token },
              locale: "zh-CN",
              userAgent: "okf-active-memory-verify/1.0.0"
            }, 15000);
            clearTimeout(failTimer);
            resolve(hello);
          } catch (error) {
            clearTimeout(failTimer);
            reject(error);
          }
          return;
        }
        this.handleFrame(frame);
      });
      this.ws.addEventListener("error", (error) => {
        clearTimeout(failTimer);
        reject(error);
      });
      this.ws.addEventListener("close", (event) => {
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error(`Gateway closed ${event.code}: ${event.reason}`));
        }
        this.pending.clear();
      });
    });
  }

  request(method, params = {}, timeoutMs = 30000) {
    const id = `okf-${++this.seq}`;
    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
  }

  waitForChatFinal(runId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const interval = setInterval(() => {
        const runEvents = this.events.filter((event) =>
          event.event === "chat" &&
          event.payload?.runId === runId
        );
        const finalEvent = runEvents.find((event) => event.payload?.state === "final");
        if (finalEvent) {
          clearInterval(interval);
          resolve(finalEvent.payload);
          return;
        }
        const failedEvent = runEvents.find((event) => ["error", "failed", "aborted", "cancelled"].includes(event.payload?.state));
        if (failedEvent) {
          clearInterval(interval);
          const detail = failedEvent.payload?.error?.message || failedEvent.payload?.error || failedEvent.payload?.message || "no detail";
          reject(new Error(`Chat run ${runId} ended with state=${failedEvent.payload.state}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`));
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(interval);
          reject(new Error(`Timed out waiting for chat final: ${runId}`));
        }
      }, 500);
    });
  }

  handleFrame(frame) {
    if (frame.type === "res") {
      const item = this.pending.get(frame.id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(frame.id);
      if (frame.ok) item.resolve(frame.payload);
      else item.reject(new Error(JSON.stringify(frame.error)));
      return;
    }
    if (frame.type === "event") {
      this.events.push(frame);
      if (this.events.length > 1000) this.events.splice(0, this.events.length - 1000);
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Best-effort cleanup.
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
