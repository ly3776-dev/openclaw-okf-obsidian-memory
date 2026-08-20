#!/usr/bin/env bash
set -euo pipefail

VAULT="./examples/vault"
START_BGE=0
INSTALL_SERVICE=0
INSTALL_MODE="AUTO"
ALLOW_PROVIDER_REPLACE=0
NETWORK_PROFILE="CN"
NPM_REGISTRY_VALUE=""
PIP_INDEX_URL_VALUE=""
HF_ENDPOINT_VALUE=""
MODEL_HUB_VALUE=""
PADDLE_MODEL_SOURCE_VALUE=""
SKIP_OPENCLAW=0
SKIP_PYTHON=0
SKIP_VERIFY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault) VAULT="$2"; shift 2 ;;
    --install-bge) INSTALL_MODE="ISOLATED"; shift ;;
    --start-bge) START_BGE=1; shift ;;
    --install-service) INSTALL_SERVICE=1; shift ;;
    --install-mode) INSTALL_MODE="${2^^}"; shift 2 ;;
    --allow-provider-replace) ALLOW_PROVIDER_REPLACE=1; shift ;;
    --network-profile) NETWORK_PROFILE="${2^^}"; shift 2 ;;
    --npm-registry) NPM_REGISTRY_VALUE="$2"; shift 2 ;;
    --pip-index-url) PIP_INDEX_URL_VALUE="$2"; shift 2 ;;
    --hf-endpoint) HF_ENDPOINT_VALUE="$2"; shift 2 ;;
    --model-hub) MODEL_HUB_VALUE="$2"; shift 2 ;;
    --paddle-model-source) PADDLE_MODEL_SOURCE_VALUE="$2"; shift 2 ;;
    --skip-openclaw) SKIP_OPENCLAW=1; shift ;;
    --skip-python) SKIP_PYTHON=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    *) echo "Unknown argument / 未知参数: $1" >&2; exit 2 ;;
  esac
done

case "$INSTALL_MODE" in
  AUTO|REUSE_EXISTING|SIDECAR|ISOLATED) ;;
  *) echo "Invalid install mode / 无效安装模式: $INSTALL_MODE" >&2; exit 2 ;;
esac
case "$NETWORK_PROFILE" in
  CN|GLOBAL|CUSTOM) ;;
  *) echo "Invalid network profile / 无效下载源方案: $NETWORK_PROFILE" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="$(cd "$(dirname "$VAULT")" && pwd)/$(basename "$VAULT")"
cd "$ROOT"
echo "== OKF Obsidian Memory bootstrap (Linux) / 安装（Linux） =="

command -v node >/dev/null 2>&1 || { echo "Node.js 24 LTS is required / 需要 Node.js 24 LTS" >&2; exit 1; }
node -e "const [a,b,c]=process.versions.node.split('.').map(Number); process.exit(a>24 || (a===24 && (b>15 || (b===15 && c>=0))) ? 0 : 1)" || { echo "Node.js >=24.15.0 LTS is required / 需要 Node.js >=24.15.0 LTS" >&2; exit 1; }
SOURCE_ARGS=("$ROOT/scripts/resolve_install_sources.js" --profile "$NETWORK_PROFILE")
[[ -n "$NPM_REGISTRY_VALUE" ]] && SOURCE_ARGS+=(--npm-registry "$NPM_REGISTRY_VALUE")
[[ -n "$PIP_INDEX_URL_VALUE" ]] && SOURCE_ARGS+=(--pip-index-url "$PIP_INDEX_URL_VALUE")
[[ -n "$HF_ENDPOINT_VALUE" ]] && SOURCE_ARGS+=(--hf-endpoint "$HF_ENDPOINT_VALUE")
[[ -n "$MODEL_HUB_VALUE" ]] && SOURCE_ARGS+=(--model-hub "$MODEL_HUB_VALUE")
[[ -n "$PADDLE_MODEL_SOURCE_VALUE" ]] && SOURCE_ARGS+=(--paddle-model-source "$PADDLE_MODEL_SOURCE_VALUE")
SOURCE_JSON="$(node "${SOURCE_ARGS[@]}")"
source_field() {
  node -e 'const v=JSON.parse(process.argv[1])[process.argv[2]];process.stdout.write(String(v));' "$SOURCE_JSON" "$1"
}
NPM_REGISTRY_VALUE="$(source_field npmRegistry)"
PIP_INDEX_URL_VALUE="$(source_field pipIndexUrl)"
HF_ENDPOINT_VALUE="$(source_field hfEndpoint)"
MODEL_HUB_VALUE="$(source_field modelHub)"
PADDLE_MODEL_SOURCE_VALUE="$(source_field paddleModelSource)"
export npm_config_registry="$NPM_REGISTRY_VALUE"
export npm_config_replace_registry_host=always
export PIP_INDEX_URL="$PIP_INDEX_URL_VALUE"
export PIP_DISABLE_PIP_VERSION_CHECK=1
export HF_ENDPOINT="$HF_ENDPOINT_VALUE"
export HF_HUB_DISABLE_XET=1
export OKF_MODEL_HUB="$MODEL_HUB_VALUE"
export OKF_MODEL_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/okf-obsidian-memory/models"
export PADDLE_PDX_MODEL_SOURCE="$PADDLE_MODEL_SOURCE_VALUE"
echo "Network profile / 下载源方案: $(source_field profile)"
echo "npm: $NPM_REGISTRY_VALUE"
echo "PyPI: $PIP_INDEX_URL_VALUE"
echo "Hugging Face: $HF_ENDPOINT_VALUE"
echo "Model downloads / 模型下载: $MODEL_HUB_VALUE -> $OKF_MODEL_CACHE_DIR"
echo "PaddleOCR models / PaddleOCR 模型源: $PADDLE_MODEL_SOURCE_VALUE"
if [[ -f "$ROOT/package-lock.json" ]]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

PLAN_ARGS=("$ROOT/scripts/plan_openclaw_install.js" --root "$ROOT" --mode "$INSTALL_MODE")
[[ "$ALLOW_PROVIDER_REPLACE" == "1" ]] && PLAN_ARGS+=(--allow-provider-replace)
PLAN_JSON="$(node "${PLAN_ARGS[@]}")"
plan_field() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(typeof v==="string"?v:JSON.stringify(v));});' "$1" <<<"$PLAN_JSON"
}
RESOLVED_MODE="$(plan_field resolvedMode)"
INSTALL_ISOLATED_BGE="$(plan_field installBge)"
echo "Install mode / 安装模式: $RESOLVED_MODE ($(plan_field reason))"
echo "Existing Gateway preserved / 保留现有 Gateway: $(plan_field preserveExistingGateway)"
echo "Install isolated CPU BGE / 安装独立 CPU BGE: $INSTALL_ISOLATED_BGE"

VENV_PYTHON="$ROOT/.venv/bin/python"
if [[ "$SKIP_PYTHON" != "1" ]]; then
  PYTHON_CANDIDATES=()
  if [[ -n "${PYTHON:-}" ]]; then
    PYTHON_CANDIDATES+=("$PYTHON")
  else
    PYTHON_CANDIDATES+=(python3.13 python3.12 python3.11 python3.10 python3.9 python3)
  fi
  PYTHON=""
  for candidate in "${PYTHON_CANDIDATES[@]}"; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(not ((3, 9) <= sys.version_info[:2] < (3, 14)))'; then
      PYTHON="$candidate"
      break
    fi
  done
  if [[ -z "$PYTHON" ]]; then
    echo "Python 3.9-3.13 is required because PaddlePaddle does not provide Python 3.14 wheels. / 需要 Python 3.9-3.13：PaddlePaddle 尚未提供 Python 3.14 wheel。" >&2
    echo "Repair / 修复: PYTHON=/path/to/python3.12 ./scripts/bootstrap_linux.sh ..." >&2
    exit 1
  fi
  [[ -x "$VENV_PYTHON" ]] || "$PYTHON" -m venv "$ROOT/.venv"
  "$VENV_PYTHON" -m pip install --upgrade pip
  "$VENV_PYTHON" -m pip install -r "$ROOT/requirements.txt"
  "$VENV_PYTHON" "$ROOT/scripts/paddleocr_extract.py" --prepare
  "$VENV_PYTHON" "$ROOT/scripts/transcribe_media.py" --prepare --allow-model-download
  if [[ "$INSTALL_ISOLATED_BGE" == "true" ]]; then
    "$VENV_PYTHON" -m pip install -r "$ROOT/requirements-bge-m3.txt"
    PREPARE_ARGS=("$ROOT/scripts/prepare_bge_m3.py")
    [[ -n "$HF_ENDPOINT_VALUE" ]] && PREPARE_ARGS+=(--hf-endpoint "$HF_ENDPOINT_VALUE")
    "$VENV_PYTHON" "${PREPARE_ARGS[@]}"
  fi
fi

SNAPSHOT_PATH="$(node "$ROOT/scripts/install_snapshot.js" create --root "$ROOT" --vault "$VAULT" --openclaw-config "$(plan_field configPath)" --plan-json "$PLAN_JSON" --field snapshotDir)"
echo "Recovery snapshot / 恢复快照: $SNAPSHOT_PATH"
GATEWAY_CREATED=0
BGE_SERVICE_CREATED=0
ROLLBACK_ACTIVE=1
OPENCLAW_CMD=(node "$ROOT/node_modules/openclaw/openclaw.mjs")
rollback_install() {
  local exit_code=$?
  trap - ERR
  [[ "$GATEWAY_CREATED" == "1" ]] && "${OPENCLAW_CMD[@]}" gateway uninstall --json >/dev/null 2>&1 || true
  if [[ "$BGE_SERVICE_CREATED" == "1" ]]; then
    systemctl --user disable --now okf-bge-m3.service >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/okf-bge-m3.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  node "$ROOT/scripts/install_snapshot.js" restore --snapshot "$SNAPSHOT_PATH" >/dev/null 2>&1 || true
  if [[ "$(plan_field restartGateway)" == "true" ]]; then "${OPENCLAW_CMD[@]}" gateway restart --json >/dev/null 2>&1 || true; fi
  echo "Installation failed; protected files were restored from $SNAPSHOT_PATH / 安装失败，受保护文件已从快照恢复。" >&2
  exit "$exit_code"
}
trap rollback_install ERR

node "$ROOT/scripts/install_obsidian_plugin.js" --root "$ROOT" --vault "$VAULT"

if [[ "$INSTALL_ISOLATED_BGE" == "true" && "$INSTALL_SERVICE" == "1" ]]; then
  SERVICE_ARGS=()
  [[ -n "$HF_ENDPOINT_VALUE" ]] && SERVICE_ARGS+=(--hf-endpoint "$HF_ENDPOINT_VALUE")
  "$ROOT/scripts/install_bge_service_linux.sh" "${SERVICE_ARGS[@]}"
  BGE_SERVICE_CREATED=1
elif [[ "$INSTALL_ISOLATED_BGE" == "true" && "$START_BGE" == "1" ]]; then
  BGE_ARGS=()
  [[ -n "$HF_ENDPOINT_VALUE" ]] && BGE_ARGS+=(--hf-endpoint "$HF_ENDPOINT_VALUE")
  "$ROOT/scripts/start_bge_m3.sh" "${BGE_ARGS[@]}"
fi

if [[ "$SKIP_OPENCLAW" != "1" ]]; then
  if [[ "$INSTALL_ISOLATED_BGE" == "true" ]]; then
    BGE_READY=0
    for _ in {1..90}; do
      if node "$ROOT/scripts/check_embedding_server.js" >/dev/null 2>&1; then BGE_READY=1; break; fi
      sleep 2
    done
    [[ "$BGE_READY" == "1" ]] || { echo "BGE-M3 did not become healthy within 180 seconds. / BGE-M3 未在 180 秒内就绪。" >&2; false; }
    node "$ROOT/scripts/check_embedding_server.js"
  fi
  PLUGIN_INSTALL_PATH="$(node "$ROOT/scripts/prepare_openclaw_plugin.js" --print-path)"
  [[ -d "$PLUGIN_INSTALL_PATH" ]] || { echo "OpenClaw plugin staging failed / OpenClaw 插件暂存失败" >&2; false; }
  [[ -f "$ROOT/node_modules/openclaw/openclaw.mjs" ]] || { echo "OpenClaw CLI is missing / 未找到 OpenClaw CLI。" >&2; false; }
  node "$ROOT/scripts/install_openclaw_plugin.js" --root "$ROOT" --plugin-path "$PLUGIN_INSTALL_PATH"
  node "$ROOT/src/cli.js" okf-export --vault "$VAULT"
  MEMORY_ARGS=("$ROOT/scripts/configure_openclaw_memory.js" --vault "$VAULT" --mode "$RESOLVED_MODE")
  if [[ "$(plan_field configureProvider)" == "true" ]]; then MEMORY_ARGS+=(--provider openai-compatible --model BAAI/bge-m3); fi
  if [[ "$(plan_field enableActiveMemory)" == "true" ]]; then MEMORY_ARGS+=(--active-memory); fi
  if [[ "$(plan_field indexMemory)" == "true" ]]; then MEMORY_ARGS+=(--index); fi
  [[ "$ALLOW_PROVIDER_REPLACE" == "1" ]] && MEMORY_ARGS+=(--allow-provider-replace)
  node "${MEMORY_ARGS[@]}"
  if [[ "$(plan_field installGateway)" == "true" ]]; then
    "${OPENCLAW_CMD[@]}" gateway install --json
    GATEWAY_CREATED=1
  fi
  if [[ "$(plan_field restartGateway)" == "true" ]]; then
    "${OPENCLAW_CMD[@]}" gateway restart --json
  elif [[ "$(plan_field startGateway)" == "true" ]]; then
    "${OPENCLAW_CMD[@]}" gateway start --json
  fi
fi

if [[ "$SKIP_VERIFY" != "1" ]]; then
  node "$ROOT/scripts/setup_check.js" --vault "$VAULT"
  node "$ROOT/src/cli.js" sqlite-index --vault "$VAULT"
  node "$ROOT/scripts/verify_all.js" --skip-openclaw --skip-embedding --skip-obsidian-cli
fi
node "$ROOT/scripts/install_snapshot.js" complete --snapshot "$SNAPSHOT_PATH" --changes-json "$(plan_field changes)" >/dev/null
ROLLBACK_ACTIVE=0
trap - ERR
echo "Installation complete / 安装完成。"
echo "Install mode / 安装模式: $RESOLVED_MODE"
echo "Recovery snapshot / 恢复快照: $SNAPSHOT_PATH"
