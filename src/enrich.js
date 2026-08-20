import { spawn } from "node:child_process";

export async function runWebEnrichment({ text, title, enabled = false, timeoutMs = 90000 } = {}) {
  const command = process.env.OKF_WEB_ENRICH_COMMAND;
  const tavilyKey = process.env.OKF_TAVILY_API_KEY || process.env.TAVILY_API_KEY;
  if (!enabled && !command && !tavilyKey) {
    return { ok: true, skipped: true, reason: "Web enrichment disabled", text: "", citations: [] };
  }

  const payload = {
    task: "okf_web_enrichment",
    instruction: [
      "Research missing context for the provided capture.",
      "Return JSON with fields: text, citations.",
      "citations should be an array of URLs or short source labels.",
      "Avoid uncited factual claims."
    ].join(" "),
    title,
    text
  };

  if (tavilyKey) return runTavilySearch({ apiKey: tavilyKey, title, text, timeoutMs });
  if (!command) {
    return { ok: false, skipped: true, reason: "OKF_WEB_ENRICH_COMMAND or OKF_TAVILY_API_KEY is not set", text: "", citations: [] };
  }

  const result = await runCommand(command, JSON.stringify(payload), timeoutMs);
  if (!result.ok) return { ...result, text: "", citations: [] };

  try {
    const parsed = JSON.parse(result.stdout.trim());
    return {
      ok: true,
      skipped: false,
      text: String(parsed.text || "").trim(),
      citations: Array.isArray(parsed.citations) ? parsed.citations.map(String) : []
    };
  } catch {
    return {
      ok: true,
      skipped: false,
      text: result.stdout.trim(),
      citations: []
    };
  }
}

async function runTavilySearch({ apiKey, title, text, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        query: buildSearchQuery(title, text),
        search_depth: "advanced",
        include_answer: true,
        include_raw_content: false,
        max_results: 5
      })
    });
    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, skipped: false, provider: "tavily", reason: `HTTP ${response.status}`, text: "", citations: [], stderr: raw };
    }
    const data = JSON.parse(raw);
    const results = Array.isArray(data.results) ? data.results : [];
    const citations = results.map((item) => item.url).filter(Boolean);
    const snippets = results
      .map((item) => `- ${item.title || item.url}: ${item.content || ""}`.trim())
      .filter(Boolean)
      .join("\n");
    const answer = data.answer ? `Answer: ${data.answer}` : "";
    return {
      ok: true,
      skipped: false,
      provider: "tavily",
      text: [answer, snippets].filter(Boolean).join("\n\n").trim(),
      citations
    };
  } catch (error) {
    return { ok: false, skipped: false, provider: "tavily", reason: error.message, text: "", citations: [] };
  } finally {
    clearTimeout(timer);
  }
}

function buildSearchQuery(title, text) {
  const cleanTitle = String(title || "").trim();
  const cleanText = String(text || "").replace(/\s+/g, " ").trim();
  const titleLooksSynthetic = /验证|test|mock|demo|示例/i.test(cleanTitle);
  return [cleanText.slice(0, 260), titleLooksSynthetic ? "" : cleanTitle].filter(Boolean).join(" ");
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
      resolve({ ok: false, skipped: false, reason: `Web enrichment command timed out after ${timeoutMs}ms`, stdout, stderr });
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
        resolve({ ok: true, skipped: false, stdout, stderr });
      } else {
        resolve({ ok: false, skipped: false, reason: `Web enrichment command exited with ${code}`, stdout, stderr });
      }
    });

    child.stdin.end(stdin);
  });
}
