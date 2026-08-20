# OpenClaw Install And Verification

This project ships both:

- a native OpenClaw tool plugin entry: `plugin/native.js`
- a skill instruction file: `skill/OKF_OBSIDIAN_MEMORY.md`

## Install Dependencies

## Easy Install / 简易安装（推荐）

Windows: extract the ZIP and double-click:

```text
INSTALL_WINDOWS.cmd
```

Select the Vault in the folder dialog. Missing Node.js 24 LTS, Python 3.12, and FFmpeg are installed through winget when available. Before changing OpenClaw or the Vault plugin, the installer probes existing state and creates a recovery snapshot. At the end it opens a generated `AGENT_HANDOFF.md`; copy that one file to the Agent.

Windows：解压后双击 `INSTALL_WINDOWS.cmd`，在弹窗中选择 Vault。安装器会自动处理前置组件、项目依赖、模型、插件、自启动、索引和检查，最后打开生成的 `AGENT_HANDOFF.md`；只需把这一份文件交给 Agent。

Linux:

```bash
bash ./install-linux.sh
```

With `zenity`, Linux shows a graphical Vault picker; otherwise it asks for the path once. It requires Node.js >=24.15.0 LTS, Python 3.9-3.13, and a working systemd user session. It installs missing FFmpeg through apt, dnf, or pacman and generates the same one-file Agent handoff.

Linux 有 `zenity` 时会弹出 Vault 目录选择器，否则只询问一次路径。需要 Node.js >=24.15.0 LTS、Python 3.9-3.13 和可用的 systemd 用户会话；缺少 FFmpeg 时会通过发行版包管理器安装。

### Safe coexistence modes

The default `AUTO` planner uses read-only `config`, `memory status`, `memory search`, and Gateway status checks:

| Mode | Selection | OpenClaw provider | BGE service | Existing Gateway |
|---|---|---|---|---|
| `REUSE_EXISTING` | Existing vector provider and probe are healthy | Preserved and reused | Not installed | Service definition preserved |
| `SIDECAR` | A provider exists but its probe is unhealthy | Preserved without replacement | Not installed | Service definition preserved |
| `ISOLATED` | No semantic provider exists | Configured for local CPU BGE-M3 | Installed without overwriting a same-name service | Installed only if missing |

Windows example: `INSTALL_WINDOWS.cmd -InstallMode SIDECAR`. Linux example: `bash ./install-linux.sh --install-mode SIDECAR`.

Every real install creates a current-user-only snapshot under `%LOCALAPPDATA%\OKF Obsidian Memory\install-snapshots` on Windows or `${XDG_STATE_HOME:-~/.local/state}/okf-obsidian-memory/install-snapshots` on Linux. Failures restore the previous OpenClaw config, Obsidian community plugin list, the complete prior OKF Obsidian plugin directory, and `okf-obsidian.config.json`, then purge the used credential backup. Successful installs retain the protected snapshot and write the non-secret pointer `.okf-install/last-install.json`. Derived indexes are rebuildable and intentionally excluded from rollback.

### Mainland China download profile

`CN` is the easy-installer default. It applies all download routes before any dependency command runs:

- npm: `https://registry.npmmirror.com` with lockfile registry-host replacement enabled;
- PyPI: `https://pypi.tuna.tsinghua.edu.cn/simple`;
- Faster-Whisper, BGE-M3, and PaddleOCR model binaries: ModelScope, downloaded into local caches;
- Hugging Face compatibility endpoint: `https://hf-mirror.com`, with Xet disabled;
- PaddleOCR source selection: `PADDLE_PDX_MODEL_SOURCE=modelscope`.

The bootstrap preloads PaddleOCR and Faster-Whisper models. It downloads BGE-M3 only in `ISOLATED`; `REUSE_EXISTING` never duplicates the target OpenClaw embedding model. Use `GLOBAL` for official Hugging Face sources, or `CUSTOM` with explicit `NpmRegistry`/`PipIndexUrl`/`HfEndpoint`/`ModelHub`/`PaddleModelSource` values. Non-loopback custom URLs must use HTTPS.

Advanced unattended Windows install:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap_windows.ps1 -Vault "D:\Obsidian\MyVault" -InstallMode AUTO -InstallService -NetworkProfile CN
```

Advanced unattended Linux install:

```bash
bash ./scripts/bootstrap_linux.sh --vault "$HOME/Vault" --install-mode AUTO --install-service --network-profile CN
```

These scripts require Node.js >=24.15.0 LTS and Python 3.9-3.13, create `.venv`, install/enable the Obsidian plugin, and prepare CPU OCR/transcription. BGE-M3 and its auto-start service are prepared only in `ISOLATED`. Existing Gateway service definitions are preserved; a Gateway is installed only when none exists. Python 3.14 is not currently supported because the pinned PaddlePaddle release has no compatible wheel; use `PYTHON=/path/to/python3.12` (or Python 3.13) when the system default is 3.14.

Manual install:

```powershell
npm install
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-bge-m3.txt
```

Do not rely on the first ingest to download transcription models. The guided bootstrap prepares Faster-Whisper automatically. For a manual install or repair, run `npm run media:prepare` (optionally set `HF_ENDPOINT=https://hf-mirror.com` and `HF_HUB_DISABLE_XET=1`) or configure `OKF_FASTER_WHISPER_MODEL_PATH` / `OKF_FUNASR_MODEL_PATH` to existing local model directories. Formal ingest runs in local-only mode and fails quickly with a recovery command when a model is absent.

On Linux, use the same commands from a shell:

```bash
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt -r requirements-bge-m3.txt
```

## Link Plugin Into OpenClaw

Build a minimal safety-scanned staging directory first. Do not ask OpenClaw to scan the project `.venv`:

```powershell
$pluginPath = node .\scripts\prepare_openclaw_plugin.js --print-path
openclaw plugins install $pluginPath --link
openclaw plugins list --json
openclaw plugins inspect openclaw-okf-obsidian-memory --json
openclaw plugins doctor
```

Linux:

```bash
plugin_path="$(node ./scripts/prepare_openclaw_plugin.js --print-path)"
openclaw plugins install "$plugin_path" --link
openclaw plugins list --json
openclaw plugins inspect openclaw-okf-obsidian-memory --json
openclaw plugins doctor
```

The native plugin metadata is declared in:

- `openclaw.plugin.json`
- `package.json` under `openclaw.extensions`

If you renamed the plugin from an older local build, remove stale OpenClaw config entries for `okf-obsidian-memory`; the current plugin id is `openclaw-okf-obsidian-memory`.

## Tool Names

- `okf_obsidian_ingest`
- `okf_obsidian_daily`
- `okf_obsidian_recall`
- `okf_obsidian_sqlite_index`
- `okf_obsidian_douyin`
- `okf_obsidian_doctor`
- `okf_obsidian_okf_validate`
- `okf_obsidian_ontology_validate`
- `okf_obsidian_actions_validate`
- `okf_obsidian_actions_list`
- `okf_obsidian_action_update`
- `okf_obsidian_action_execute`
- `okf_obsidian_obsidian_views`
- `okf_obsidian_okf_export`

## Ontology And Optional LLM/Web Enrichment

Daily synthesis builds a Palantir-inspired ontology graph at:

```text
<Vault>/.okf-cache/ontology.json
```

The graph models:

- object types: `Concept`, `Source`, `Tag`, `Entity`
- link types: `derived_from`, `has_tag`, `mentions`, `similar_to`, `same_domain`
- action types: `merge_duplicate_concepts`, `promote_entity_note`, `enrich_ambiguous_concept`, `schedule_review`

Optional web enrichment is controlled by `OKF_WEB_ENRICH_COMMAND`. The command receives JSON on stdin and should return either JSON with `text` and `citations`, or plain text.

Optional LLM ontology review is controlled by `OKF_ONTOLOGY_LLM_COMMAND`. The command receives the ontology graph JSON on stdin and should return Markdown.

Production provider environment variables:

```powershell
$env:OKF_LLM_BASE_URL="http://your-openai-compatible-gateway/"
$env:OKF_LLM_API_KEY="sk-..."
$env:OKF_LLM_MODEL="your-chat-model"
$env:OKF_TAVILY_API_KEY="tvly-..."
```

For high-quality vector recall, set an OpenAI-compatible embedding model:

```powershell
$env:OKF_EMBEDDING_BASE_URL=$env:OKF_LLM_BASE_URL
$env:OKF_EMBEDDING_API_KEY=$env:OKF_LLM_API_KEY
$env:OKF_EMBEDDING_MODEL="your-embedding-model"
```

Local BGE-M3 server:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install_bge_service_windows.ps1
npm run embedding:health
```

Linux:

```bash
bash ./scripts/install_bge_service_linux.sh
npm run embedding:health
```

Examples:

```powershell
node ./src/cli.js ingest --vault ./examples/vault --text "模糊内容" --use-web
node ./src/cli.js daily --vault ./examples/vault --use-llm
```

Recall builds a local vector index at:

```text
<Vault>/.okf-cache/vector-index.json
```

Recall also maintains a derived SQLite/FTS speed layer at:

```text
<Vault>/.okf-cache/okf-memory.sqlite
```

SQLite does not replace vector search. SQLite accelerates large-vault exact/FTS recall, while the vector index provides semantic recall. The source of truth remains the OKF Markdown notes plus ontology graph.

Rebuild the SQLite cache after bulk import or migration:

```powershell
node ./src/cli.js sqlite-index --vault ./examples/vault
```

Strict OKF validation and export:

```powershell
node ./src/cli.js ontology-validate --vault ./examples/vault
node ./src/cli.js action-validate --vault ./examples/vault
node ./src/cli.js action-list --vault ./examples/vault --status proposed
node ./src/cli.js action-update --vault ./examples/vault --id "action:..." --status accepted --note "reviewed"
node ./src/cli.js action-execute --vault ./examples/vault --id "action:..."
node ./src/cli.js obsidian-views --vault ./examples/vault
node ./src/cli.js sqlite-index --vault ./examples/vault
node ./src/cli.js okf-validate --vault ./examples/vault
node ./src/cli.js okf-export --vault ./examples/vault
```

## Local Verification

```powershell
npm run setup:check
npm run verify:all
npm run release:package
npm run release:check
```

For a release acceptance, keep Obsidian desktop open and require `npm run verify:obsidian-cli` to return `ok: true`, `skipped: false`, plugin version/enabled state, a successful plugin reload, and `No errors captured.` Use `--skip-obsidian-cli` only for an explicitly partial offline gate; never report it as full desktop validation.

For a staged run:

```powershell
npm test
npm run verify:plugin
node ./src/cli.js doctor
npm run verify:obsidian
npm run verify:obsidian-cli
npm run security:check
npm run sqlite:index
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

`npm run recall:quality` verifies Chinese spoken-style semantic recall with the configured BGE-M3/OpenAI-compatible embedding endpoint. For an offline smoke run, use:

```powershell
npm run verify:all -- --skip-embedding
```

Optional sample run:

```powershell
node ./src/cli.js ingest --input ./examples/sample-image.png --vault ./examples/vault
node ./src/cli.js ingest --input ./examples/sample-pdf.pdf --vault ./examples/vault
node ./src/cli.js recall --vault ./examples/vault --query "OpenClaw OCR"
node ./src/cli.js okf-validate --vault ./examples/vault
node ./src/cli.js okf-export --vault ./examples/vault
```

## Douyin

Douyin download logic is project-local in `scripts/douyin_download.py`; it does not depend on a user-specific Codex/OpenClaw skill path. It first tries the legacy embedded page data, then uses `scripts/douyin_browser_resolve.js` to capture Douyin's official signed detail response in a temporary local Chromium session. The link is not sent to a third-party parsing service. The CLI command is:

```powershell
node ./src/cli.js douyin --url "https://v.douyin.com/xxxxx/" --vault "D:\Obsidian\MyVault"
```

For tests or special deployments, override the downloader script:

```powershell
$env:OKF_DOUYIN_DOWNLOADER_SCRIPT="D:\path\to\custom_downloader.py"
```

The current official-page fallback needs Chrome, Edge, Chromium, or a Playwright-managed Chromium build. Browser discovery is automatic. To select one explicitly:

```powershell
$env:OKF_DOUYIN_BROWSER_EXECUTABLE="C:\Program Files\Google\Chrome\Application\chrome.exe"
```

## Migration Notes

- Prefer the generated release bundle from `npm run release:package`.
- Move `release/okf-obsidian-memory-<version>.zip` or its extracted folder to the target machine.
- Re-run `npm install`, create `.venv`, and install both Python requirement files on the target machine.
- Or run `scripts/bootstrap_windows.ps1` / `scripts/bootstrap_linux.sh` for a guided install.
- Leave the mode at `AUTO`: a healthy target OpenClaw vector provider is reused; a configured-but-unhealthy provider fails closed to `SIDECAR`; only a target with no semantic provider receives the isolated CPU BGE service.
- Do not use `ISOLATED --allow-provider-replace` unless replacing the target provider is an explicit migration decision with an inspected recovery snapshot.
- OpenClaw should link the generated minimal staging directory, not the project root containing `.venv`.
- The Obsidian vault is just a folder. Pass its path as `vault`.

## Obsidian Companion Plugin

The companion plugin is in `obsidian/`. Install it into a vault as:

```text
<Vault>/.obsidian/plugins/okf-obsidian-memory/
```

Then enable `OKF Obsidian Memory` in Obsidian settings. In the plugin settings, set `Project root` to the folder that contains this repository's `package.json`.
The settings page has a `语言 / Language` selector for Chinese/English switching.

The plugin is desktop-only and wraps the existing CLI. It provides a manual command and a daily scheduler:

- `运行 OKF 每日归纳 / Run OKF daily synthesis`
- `校验严格 OKF / Validate strict OKF`
- `校验 Ontology 图 / Validate ontology graph`
- `校验 Ontology 动作队列 / Validate ontology actions`
- `打开 Ontology 动作队列 / Open ontology action queue`
- `刷新 Obsidian Ontology 视图 / Refresh Obsidian ontology views`
- `重建 SQLite 记忆索引 / Rebuild SQLite memory index`
- `导出严格 OKF 包 / Export strict OKF bundle`
- daily synthesis once per local day after the configured time, while Obsidian is open

See `docs/OBSIDIAN_SKILLS_INTEGRATION.md` for Obsidian CLI, Canvas, and Bases integration.
