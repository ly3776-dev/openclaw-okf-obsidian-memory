import { spawn } from "node:child_process";

export async function runOntologyLlm({ vault, graph, notes, enabled = false, timeoutMs = 120000 } = {}) {
  const command = process.env.OKF_ONTOLOGY_LLM_COMMAND;
  const openai = getOpenAiConfig();
  if (!enabled && !command && !openai) {
    return { ok: true, skipped: true, reason: "LLM enrichment disabled" };
  }

  const payload = {
    task: "okf_ontology_daily_synthesis",
    instruction: [
      "Use the ontology schema to explain high-value links.",
      "Prefer object/property/link/action language.",
      "Return concise Markdown with: Important Links, Missing Context, Suggested Actions.",
      "Do not invent citations; mark uncertain claims as hypotheses."
    ].join(" "),
    vault,
    graph,
    notes: notes.map(({ body, ...note }) => note)
  };

  if (openai) return runOpenAiChat(openai, payload, timeoutMs);
  if (command) return runCommand(command, JSON.stringify(payload), timeoutMs);
  return { ok: false, skipped: true, reason: "No LLM provider configured" };
}

function getOpenAiConfig() {
  const baseUrl = process.env.OKF_LLM_BASE_URL || process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OKF_LLM_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.OKF_LLM_MODEL || process.env.OPENAI_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

async function runOpenAiChat(config, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(openAiUrl(config.baseUrl, "chat/completions"), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content: "You are an ontology analyst for an OKF Obsidian memory system. Return concise Markdown only."
          },
          {
            role: "user",
            content: JSON.stringify(payload)
          }
        ]
      })
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, skipped: false, provider: "openai-compatible-chat", reason: `HTTP ${response.status}`, stderr: text };
    }
    const data = JSON.parse(text);
    const markdown = data.choices?.[0]?.message?.content?.trim() || "";
    return { ok: true, skipped: false, provider: "openai-compatible-chat", model: config.model, markdown };
  } catch (error) {
    return { ok: false, skipped: false, provider: "openai-compatible-chat", reason: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function openAiUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  if (/\/v1$/i.test(base)) return `${base}/${normalizedPath}`;
  return `${base}/v1/${normalizedPath}`;
}

function runCommand(command, stdin, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, skipped: false, reason: `LLM command timed out after ${timeoutMs}ms`, stdout, stderr });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, skipped: false, reason: error.message, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, skipped: false, markdown: stdout.trim(), stderr });
      } else {
        resolve({ ok: false, skipped: false, reason: `LLM command exited with ${code}`, stdout, stderr });
      }
    });

    child.stdin.end(stdin);
  });
}
