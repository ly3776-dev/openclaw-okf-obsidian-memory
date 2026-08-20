# OpenClaw OKF Obsidian Memory

Release candidate for an OpenClaw skill and Obsidian plugin that turns incoming content into OKF-compatible Markdown notes inside an Obsidian vault.

The first version keeps the core workflow local and verifiable:

- ingest text, Markdown, JSON, CSV, HTML, and XML-like file content;
- extract a concise knowledge note;
- write an OKF-flavored Markdown file into an Obsidian vault folder;
- maintain local JSON, SQLite/FTS, and vector recall indexes;
- run a daily linker/synthesis pass;
- recall related notes by lexical, SQLite, ontology, and vector relevance.
- build an ontology graph over concepts, sources, tags, and entities for daily synthesis and recall.

## Quick Start

Windows users: extract the release ZIP and double-click `INSTALL_WINDOWS.cmd`. Select the Obsidian Vault folder once. The installer first probes the existing OpenClaw installation, chooses a non-destructive install mode, snapshots protected config/plugin files, and then prepares only the missing components. When it finishes, copy the generated `AGENT_HANDOFF.md` to the Agent.

Windows 用户：解压发布 ZIP 后双击 `INSTALL_WINDOWS.cmd`，只选择一次 Obsidian Vault。安装器会先探测已有 OpenClaw，选择非覆盖模式并备份受保护配置/插件文件，只安装缺失组件；完成后只需把生成的 `AGENT_HANDOFF.md` 交给 Agent。

Linux:

```bash
bash ./install-linux.sh
```

Linux 有 `zenity` 时使用图形目录选择器，否则只询问一次 Vault 路径。安装完成后同样生成单个 `AGENT_HANDOFF.md`。

## Portable Install

Windows target machine:

```text
Double-click INSTALL_WINDOWS.cmd / 双击 INSTALL_WINDOWS.cmd
```

Linux target machine:

```bash
bash ./install-linux.sh
```

Windows can install missing Node.js 24 LTS, Python 3.12, and FFmpeg automatically through winget. Linux requires Node.js >=24.15.0 LTS, Python 3.9-3.13, and a systemd user session; the launcher can install missing FFmpeg through the detected distribution package manager. OCR, Faster-Whisper, FunASR, and the optional BGE-M3 service run on CPU; no NVIDIA GPU is required.

The easy installers default to the `CN` network profile: npm uses `registry.npmmirror.com`, pip uses the Tsinghua PyPI mirror, Faster-Whisper/BGE-M3/PaddleOCR model binaries use ModelScope, and `hf-mirror.com` remains the Hugging Face compatibility endpoint. PaddleOCR, Faster-Whisper, and (when needed) BGE-M3 are downloaded during installation, so normal ingest never depends on a surprise first-use download. Use `-NetworkProfile GLOBAL` on Windows or `--network-profile GLOBAL` on Linux to use official global sources. Air-gapped or enterprise mirrors can use `CUSTOM` plus explicit npm/PyPI/HF/model-hub/Paddle source arguments; insecure non-loopback HTTP sources are rejected.

`AUTO` is the default safe mode:

- `REUSE_EXISTING`: a read-only OpenClaw memory probe succeeds, so the installer reuses its provider/model and does not install BGE or replace the Gateway service.
- `SIDECAR`: an existing semantic provider is configured but not healthy; the installer adds the OKF plugin/export path while preserving provider, Active Memory, and Gateway configuration.
- `ISOLATED`: no semantic provider is configured, so a separate CPU BGE-M3 endpoint is installed. It refuses to replace an existing provider unless `--allow-provider-replace` is explicit.

Before mutating OpenClaw config or the Vault companion plugin, both launchers create a recovery snapshot in the user's private state directory (`%LOCALAPPDATA%\OKF Obsidian Memory\install-snapshots` on Windows or `${XDG_STATE_HOME:-~/.local/state}/okf-obsidian-memory/install-snapshots` on Linux). Windows ACLs are restricted to the current account; Linux uses 0700/0600. A failed install restores protected files and purges the used credential backup. Existing Gateway services are restarted when needed but are never reinstalled with `--force`.

Advanced operators can still call `scripts/bootstrap_windows.ps1` or `scripts/bootstrap_linux.sh` directly.

Explicit modes: Windows `-InstallMode REUSE_EXISTING|SIDECAR|ISOLATED`; Linux `--install-mode REUSE_EXISTING|SIDECAR|ISOLATED`.

Explicit download profiles: Windows `-NetworkProfile CN|GLOBAL|CUSTOM`; Linux `--network-profile CN|GLOBAL|CUSTOM`.

For the required real-Linux pre/post-reboot acceptance evidence, follow `docs/LINUX_M5_VALIDATION.md`.

## Real Vault Usage

```powershell
node ./src/cli.js ingest --input "C:\path\to\source.md" --vault "D:\Obsidian\MyVault" --source-type text
node ./src/cli.js ingest --input "C:\path\to\data.json" --vault "D:\Obsidian\MyVault"
node ./src/cli.js douyin --url "https://v.douyin.com/xxxxx/" --vault "D:\Obsidian\MyVault"
node ./src/cli.js daily --vault "D:\Obsidian\MyVault"
node ./src/cli.js recall --vault "D:\Obsidian\MyVault" --query "your topic"
node ./src/cli.js sqlite-index --vault "D:\Obsidian\MyVault"
node ./src/cli.js ontology-validate --vault "D:\Obsidian\MyVault"
node ./src/cli.js action-validate --vault "D:\Obsidian\MyVault"
node ./src/cli.js action-list --vault "D:\Obsidian\MyVault"
node ./src/cli.js action-update --vault "D:\Obsidian\MyVault" --id "action:..." --status accepted --note "reviewed"
node ./src/cli.js action-execute --vault "D:\Obsidian\MyVault" --id "action:..."
node ./src/cli.js obsidian-views --vault "D:\Obsidian\MyVault"
node ./src/cli.js okf-validate --vault "D:\Obsidian\MyVault"
node ./src/cli.js okf-export --vault "D:\Obsidian\MyVault"
```

`--source-type` defaults to `auto`. The current local extractor supports `txt`, `md`, `markdown`, `json`, `csv`, `html`, `htm`, `xml`, and `log`.

PDF, image, audio, and video files now route through OCR/transcription adapters. For images and PDFs, the current first-choice OCR backend is PaddleOCR PP-OCRv6 medium. MarkItDown remains the fallback for non-OCR conversions. If the OCR path returns no text, the CLI fails with an explicit setup message.

Install the Python extraction dependencies with:

```powershell
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Check extractor availability with:

```powershell
node ./src/cli.js doctor
```

The extractor doctor reports `markitdown`, `paddleocr`, `faster_whisper`, and `funasr` availability. Formal ingest never downloads OCR/transcription models. The guided bootstrap prepares PaddleOCR and Faster-Whisper from the selected model hub automatically. For a manual install or repair, prepare Faster-Whisper explicitly after selecting the same network profile:

```powershell
npm run media:prepare
```

Default process-tree deadlines are 20 seconds for environment probes, 180 seconds for OCR/PDF, 600 seconds for transcription, and 180 seconds for Douyin download. Override them with `OKF_PROBE_TIMEOUT_MS`, `OKF_OCR_TIMEOUT_MS`, `OKF_PDF_TIMEOUT_MS`, `OKF_TRANSCRIPTION_TIMEOUT_MS`, and `OKF_DOUYIN_TIMEOUT_MS`. A timeout terminates the full process tree on Windows and Linux and returns a bilingual recovery message.

Vector indexing uses batches of 64 by default, a 30-second request timeout, and three exponential-backoff attempts. `OPENCLAW_EMBEDDING_*` host/native configuration has priority; `OKF_EMBEDDING_*` (for example local BGE-M3) is the next provider, and the offline hashed-token provider is the final fallback. Override controls with `OKF_EMBEDDING_BATCH_SIZE`, `OKF_EMBEDDING_TIMEOUT_MS`, and `OKF_EMBEDDING_RETRIES`. Vector metadata records provider, model, dimensions, and content hashes; coordinates are stored in generation-specific Float32 files instead of formatted JSON arrays.

## Ontology-Aware Daily Synthesis

Daily synthesis now writes a Palantir-inspired ontology graph to:

```text
<Vault>/.okf-cache/ontology.json
```

The graph is intentionally small and portable:

- object types: `Concept`, `Source`, `Tag`, `Entity`
- link types: `derived_from`, `has_tag`, `mentions`, `similar_to`, `same_domain`
- action types: `merge_duplicate_concepts`, `promote_entity_note`, `enrich_ambiguous_concept`, `schedule_review`

Run:

```powershell
node ./src/cli.js daily --vault "D:\Obsidian\MyVault"
```

Optional LLM review is enabled by providing a command that reads JSON from stdin and returns Markdown:

```powershell
$env:OKF_ONTOLOGY_LLM_COMMAND="your-llm-wrapper"
node ./src/cli.js daily --vault "D:\Obsidian\MyVault" --use-llm
```

Or use an OpenAI-compatible chat endpoint:

```powershell
$env:OKF_LLM_BASE_URL="http://your-openai-compatible-gateway/"
$env:OKF_LLM_API_KEY="sk-..."
$env:OKF_LLM_MODEL="your-chat-model"
node ./src/cli.js daily --vault "D:\Obsidian\MyVault" --use-llm
```

Optional web enrichment for ambiguous captures can use either a command wrapper or Tavily:

```powershell
$env:OKF_WEB_ENRICH_COMMAND="your-search-wrapper"
node ./src/cli.js ingest --vault "D:\Obsidian\MyVault" --text "模糊内容" --use-web

$env:OKF_TAVILY_API_KEY="tvly-..."
node ./src/cli.js ingest --vault "D:\Obsidian\MyVault" --text "模糊内容" --use-web
```

## Hybrid Recall Index

The memory system keeps human-readable notes plus derived machine indexes:

- Markdown notes in the vault are the source of truth and should stay comfortable to read in Obsidian.
- SQLite/FTS is a derived speed layer at `<Vault>/.okf-cache/okf-memory.sqlite`.
- The vector index is a semantic recall layer at `<Vault>/.okf-cache/vector-index.json`.

SQLite does not replace vector retrieval. `recall` returns lexical `matches`, database `sqliteMatches`, graph-based `ontologyMatches`, semantic `vectorMatches`, and merged `fusedMatches`.

Rebuild the database cache after bulk import or migration:

```powershell
node ./src/cli.js sqlite-index --vault "D:\Obsidian\MyVault"
```

The semantic recall index is stored at:

```text
<Vault>/.okf-cache/vector-index.json
<Vault>/.okf-cache/vector-index-<generation>.f32
```

The JSON file contains compact metadata and offsets; vectors are stored as little-endian Float32. A local hashed-token provider is the final fallback, while OpenClaw-native or BGE-M3 embeddings are preferred. These files are recall accelerators, not the source of truth.

For a stronger embedding provider, set `OKF_EMBEDDING_BASE_URL`, `OKF_EMBEDDING_API_KEY`, and `OKF_EMBEDDING_MODEL`.

For local BGE-M3 testing:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install_bge_service_windows.ps1
npm run embedding:health
```

Linux:

```bash
bash ./scripts/install_bge_service_linux.sh
npm run embedding:health
```

If BGE-M3 is not available on a target machine, the system still works with local hashed-token vectors, but Chinese semantic recall quality will be lower.

## OpenClaw Memory Integration

OpenClaw can index the strict OKF export directly through `memorySearch.extraPaths`, so the agent can recall this vault through its native `memory_search` / Active Memory path:

```powershell
node ./src/cli.js okf-export --vault ./examples/vault
npm run openclaw:memory
openclaw memory search --query "OpenClaw Obsidian OKF memory" --max-results 5 --json
```

For Chinese semantic recall, run the optional BGE-M3 OpenAI-compatible embedding server in `scripts/bge_m3_embedding_server.py`, then configure both OpenClaw and this project to use `http://127.0.0.1:8008/v1`.

Check the embedding endpoint with:

```powershell
npm run embedding:health
```

To let OpenClaw proactively recall OKF notes before direct chat replies, enable its built-in Active Memory plugin while registering the OKF export:

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

See `docs/OPENCLAW_MEMORY_INTEGRATION.md`.

## Strict OKF Export

The Obsidian vault can contain helper folders and plugin metadata, so strict OKF is produced as a separate bundle:

```powershell
node ./src/cli.js okf-validate --vault "D:\Obsidian\MyVault"
node ./src/cli.js okf-export --vault "D:\Obsidian\MyVault"
```

Ontology graph validation is available separately:

```powershell
node ./src/cli.js ontology-validate --vault "D:\Obsidian\MyVault"
node ./src/cli.js action-validate --vault "D:\Obsidian\MyVault"
node ./src/cli.js action-list --vault "D:\Obsidian\MyVault" --status proposed
node ./src/cli.js action-update --vault "D:\Obsidian\MyVault" --id "action:..." --status in_progress --note "started review"
node ./src/cli.js action-execute --vault "D:\Obsidian\MyVault" --id "action:..."
node ./src/cli.js obsidian-views --vault "D:\Obsidian\MyVault"
```

The export is written to `<Vault>/okf-export/`. It includes `index.md` and `log.md`, avoids Obsidian wiki links, and validates concept files for YAML frontmatter plus non-empty `type`.

Audio and video transcription uses a configured local FunASR model first, with a locally cached `faster-whisper` model as fallback. Douyin links are downloaded by the project-local downloader in `scripts/douyin_download.py`, then ingested as video. The downloader keeps the legacy page parser as a fast path and falls back to a temporary local Chrome/Edge/Chromium session that captures Douyin's official signed detail response; it does not submit links to a third-party parser:

```powershell
node ./src/cli.js douyin --url "https://v.douyin.com/xxxxx/" --vault "D:\Obsidian\MyVault"
```

In mainland China, FunASR is the preferred path because its models and tooling are generally friendlier to the local network. Model downloads belong to install/doctor preparation, never to formal ingest. Put a local faster-whisper model directory on disk and set:

```powershell
$env:OKF_FASTER_WHISPER_MODEL_PATH="D:\models\faster-whisper-small"
```

## Vault Config

On first write, the tool creates `okf-obsidian.config.json` in the vault. This controls the note folders and cache location:

```json
{
  "notesDir": "concepts",
  "dailyDir": "daily",
  "sourcesDir": "sources",
  "entitiesDir": "entities",
  "synthesesDir": "syntheses",
  "cacheDir": ".okf-cache"
}
```

## OpenClaw Pieces

- `skill/OKF_OBSIDIAN_MEMORY.md` contains the skill instructions.
- `openclaw.plugin.json` and `package.json#openclaw.extensions` declare the native OpenClaw plugin.
- `plugin/native.js` is the native OpenClaw tool-plugin entry.
- `plugin/index.js` exposes plain tool handlers backed by the tested local core.
- `obsidian/` contains the desktop Obsidian companion plugin for manual and scheduled daily synthesis.

See `docs/OPENCLAW_INSTALL.md` for install and verification commands.

## Obsidian Companion Plugin

The bootstrap installs and enables the companion plugin automatically. Manual fallback:

```text
<Vault>/.obsidian/plugins/okf-obsidian-memory/
```

Enable the plugin in Obsidian, then set the project root to this repository folder. The plugin adds:

- `运行 OKF 每日归纳 / Run OKF daily synthesis`
- `校验严格 OKF / Validate strict OKF`
- `校验 Ontology 图 / Validate ontology graph`
- `校验 Ontology 动作队列 / Validate ontology actions`
- `打开 Ontology 动作队列 / Open ontology action queue`
- `刷新 Obsidian Ontology 视图 / Refresh Obsidian ontology views`
- `重建 SQLite 记忆索引 / Rebuild SQLite memory index`
- `导出严格 OKF 包 / Export strict OKF bundle`
- `打开 OKF 记忆设置 / Open OKF memory settings`

The scheduled job runs once per local day after the configured time while Obsidian is open.
The settings page supports Chinese/English switching.

## OKF Note Shape

Each generated note uses Markdown plus YAML frontmatter:

```yaml
---
type: Concept
title: Example
description: One sentence summary.
resource: local path or URL
tags: [openclaw, okf]
timestamp: 2026-06-22T00:00:00.000Z
okf_version: "0.1"
confidence: 0.7
source_type: text
aliases: []
related: []
---
```

## Verification

Run the full local verification suite, including the OpenClaw active-memory closed loop:

```powershell
npm run setup:check
npm run verify:all
npm run release:package
npm run release:check
```

If you want to run each stage manually:

```powershell
npm test
npm run verify:plugin
npm run verify:obsidian
npm run verify:obsidian-cli
npm run ui:bilingual
npm run obsidian:views
npm run sqlite:index
npm run security:check
npm run ontology:validate
npm run actions:validate
npm run okf:validate
npm run okf:export
npm run embedding:health
npm run recall:quality
npm run verify:openclaw
npm run release:package
npm run release:check
```

`npm run recall:quality` requires the BGE-M3 OpenAI-compatible embedding endpoint by default. Use `npm run verify:all -- --skip-embedding` only when you intentionally want an offline verification pass.

If the Obsidian desktop application is intentionally closed, use `npm run verify:all -- --skip-obsidian-cli`; this skips only the live desktop CLI round trip, not the companion plugin static/runtime harness.
