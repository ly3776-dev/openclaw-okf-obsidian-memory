# OpenClaw Memory Integration

This project can feed OKF notes into OpenClaw's built-in memory search instead of duplicating long-term recall inside the skill.

## Recommended Shape

- OKF Obsidian Memory owns ingestion, extraction, enrichment, OKF export, and ontology synthesis.
- OpenClaw memory owns agent-side active recall during conversations.
- OpenClaw indexes the OKF export with its existing memory provider whenever `REUSE_EXISTING` is selected. The project-local vector cache may use its own configured endpoint or offline fallback; it is derived and does not replace OpenClaw memory.

## Register OKF Export With OpenClaw

First export strict OKF:

```powershell
node ./src/cli.js okf-export --vault ./examples/vault
```

Then register the export directory as an OpenClaw memory path:

```powershell
npm run openclaw:memory
```

The script patches `agents.defaults.memorySearch.extraPaths` to include:

```text
<Vault>/okf-export
```

Existing `memorySearch.extraPaths` entries are preserved; the script merges the OKF export path instead of replacing the whole list.

By default it sets `provider: "none"` so OpenClaw uses FTS-only recall. This is useful as a safe baseline because it does not require embedding credentials.

Verify:

```powershell
openclaw memory status --json
openclaw memory search --query "OpenClaw Obsidian OKF memory" --max-results 5 --json
```

## Use A BGE-M3 Embedding Server

Install optional dependencies:

```powershell
.venv\Scripts\python.exe -m pip install -r requirements-bge-m3.txt
.venv\Scripts\python.exe scripts\prepare_bge_m3.py --hf-endpoint https://hf-mirror.com
```

Start the local OpenAI-compatible server on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install_bge_service_windows.ps1
```

Linux:

```bash
bash ./scripts/install_bge_service_linux.sh
```

In mainland China, set a HuggingFace mirror before first model download:

```powershell
.venv\Scripts\python.exe .\scripts\prepare_bge_m3.py --hf-endpoint https://hf-mirror.com
powershell -ExecutionPolicy Bypass -File .\scripts\install_bge_service_windows.ps1 -HfEndpoint https://hf-mirror.com
```

The server defaults to the `sentence-transformers` backend and runs local-cache-only. Model download is an explicit install/doctor action. If you specifically need FlagEmbedding's native BGE-M3 sparse/ColBERT features, pass `--backend flagembedding` to the foreground starter.

Verify the endpoint:

```powershell
npm run embedding:health
```

Use it from this project:

```powershell
$env:OKF_EMBEDDING_BASE_URL="http://127.0.0.1:8008/v1"
$env:OKF_EMBEDDING_API_KEY="okf-local"
$env:OKF_EMBEDDING_MODEL="BAAI/bge-m3"
node ./src/cli.js daily --vault ./examples/vault
node ./src/cli.js recall --vault ./examples/vault --query "抖音亚马逊运营广告复盘"
```

Use it from OpenClaw:

```powershell
node ./scripts/configure_openclaw_memory.js `
  --vault ./examples/vault `
  --provider openai-compatible `
  --model BAAI/bge-m3 `
  --base-url http://127.0.0.1:8008/v1 `
  --api-key okf-local `
  --index
```

Then search:

```powershell
openclaw memory search --query "抖音亚马逊运营广告复盘" --max-results 5 --json
```

## Enable OpenClaw Active Memory

`memory_search` makes OKF notes searchable. Active Memory is the OpenClaw feature that makes recall proactive during eligible direct chat sessions.

Enable it while registering the OKF export:

```powershell
node ./scripts/configure_openclaw_memory.js `
  --vault ./examples/vault `
  --provider openai-compatible `
  --model BAAI/bge-m3 `
  --base-url http://127.0.0.1:8008/v1 `
  --api-key okf-local `
  --active-memory `
  --index
```

This writes `plugins.entries.active-memory` with:

- `agents: ["main"]`
- `allowedChatTypes: ["direct"]`
- `toolsAllow: ["memory_search", "memory_get"]`
- `queryMode: "recent"`

Restart the OpenClaw gateway after changing config, then use `/verbose on` and `/trace on` in a persistent direct chat to inspect whether Active Memory surfaced OKF notes before the main reply.

For a repeatable closed-loop verification from this repo, run:

```powershell
npm run verify:openclaw
```

The full verification wrapper also includes this step by default:

```powershell
npm run verify:all
```

This uses OpenClaw's local `gateway-client` backend helper path over `ws://127.0.0.1:18789`. It verifies all of the following:

- the Gateway accepts a local backend client with operator scopes;
- a persistent `chat.send` turn can answer from the OKF export;
- the answer and tool evidence hit `examples/vault/okf-export`;
- Gateway logs contain `active-memory ... done status=ok`.

Override the defaults when needed:

```powershell
$env:OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789"
$env:OPENCLAW_GATEWAY_TOKEN="<gateway token>"
$env:OKF_OPENCLAW_SESSION_KEY="agent:main:main"
npm run verify:openclaw
```

## Reusing OpenClaw Without Coupling To Its Model Files

`AUTO` probes OpenClaw's memory subsystem. When vector search is healthy, `REUSE_EXISTING` preserves the provider/model/credentials and only appends the OKF export path. This genuinely reuses OpenClaw's embedding behavior without opening or copying its model cache. OpenClaw-managed GGUF, QMD, provider credentials, and cache files remain private runtime assets. The stable integration boundary is:

- `memory_search`
- `active-memory`
- `memorySearch.extraPaths`
- OpenAI-compatible `/v1/embeddings`

This keeps the OKF skill portable across machines and OpenClaw versions.
