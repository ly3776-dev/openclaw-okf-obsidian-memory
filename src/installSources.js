const PROFILES = Object.freeze({
  CN: Object.freeze({
    npmRegistry: "https://registry.npmmirror.com",
    pipIndexUrl: "https://pypi.tuna.tsinghua.edu.cn/simple",
    hfEndpoint: "https://hf-mirror.com",
    modelHub: "modelscope",
    paddleModelSource: "modelscope"
  }),
  GLOBAL: Object.freeze({
    npmRegistry: "https://registry.npmjs.org",
    pipIndexUrl: "https://pypi.org/simple",
    hfEndpoint: "https://huggingface.co",
    modelHub: "huggingface",
    paddleModelSource: "huggingface"
  })
});

export function resolveInstallSources({
  profile = "CN",
  npmRegistry = "",
  pipIndexUrl = "",
  hfEndpoint = "",
  modelHub = "",
  paddleModelSource = ""
} = {}) {
  const normalizedProfile = String(profile || "CN").trim().toUpperCase();
  if (!["CN", "GLOBAL", "CUSTOM"].includes(normalizedProfile)) {
    throw new Error(`Invalid network profile: ${profile}. Expected CN, GLOBAL, or CUSTOM.`);
  }
  const defaults = PROFILES[normalizedProfile] || {};
  const resolved = {
    profile: normalizedProfile,
    npmRegistry: normalizeUrl(npmRegistry || defaults.npmRegistry, "npm registry"),
    pipIndexUrl: normalizeUrl(pipIndexUrl || defaults.pipIndexUrl, "PyPI index"),
    hfEndpoint: normalizeUrl(hfEndpoint || defaults.hfEndpoint, "Hugging Face endpoint"),
    modelHub: String(modelHub || defaults.modelHub || "").trim().toLowerCase(),
    paddleModelSource: String(paddleModelSource || defaults.paddleModelSource || "").trim().toLowerCase()
  };
  if (!resolved.npmRegistry || !resolved.pipIndexUrl || !resolved.hfEndpoint || !resolved.modelHub || !resolved.paddleModelSource) {
    throw new Error("CUSTOM requires npm registry, PyPI index, Hugging Face endpoint, model hub, and Paddle model source.");
  }
  if (!["modelscope", "huggingface"].includes(resolved.modelHub)) {
    throw new Error(`Unsupported model hub: ${resolved.modelHub}`);
  }
  if (!["aistudio", "huggingface", "modelscope", "bos"].includes(resolved.paddleModelSource)) {
    throw new Error(`Unsupported Paddle model source: ${resolved.paddleModelSource}`);
  }
  return resolved;
}

export function installSourceProfiles() {
  return PROFILES;
}

function normalizeUrl(value, label) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  let parsed;
  try { parsed = new URL(text); }
  catch { throw new Error(`Invalid ${label} URL: ${text}`); }
  if (parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) {
    throw new Error(`${label} must use HTTPS unless it is a loopback URL: ${text}`);
  }
  return text;
}

function isLoopback(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(hostname).toLowerCase());
}
