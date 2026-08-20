#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT=""
NETWORK_PROFILE="CN"
NPM_REGISTRY_VALUE=""
PIP_INDEX_URL_VALUE=""
HF_ENDPOINT_VALUE=""
MODEL_HUB_VALUE=""
PADDLE_MODEL_SOURCE_VALUE=""
NON_INTERACTIVE=0
NO_OPEN=0
DRY_RUN=0
AGENT_OUTPUT=""
INSTALL_MODE="AUTO"
ALLOW_PROVIDER_REPLACE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault) VAULT="$2"; shift 2 ;;
    --network-profile) NETWORK_PROFILE="${2^^}"; shift 2 ;;
    --npm-registry) NPM_REGISTRY_VALUE="$2"; shift 2 ;;
    --pip-index-url) PIP_INDEX_URL_VALUE="$2"; shift 2 ;;
    --hf-endpoint) HF_ENDPOINT_VALUE="$2"; shift 2 ;;
    --model-hub) MODEL_HUB_VALUE="$2"; shift 2 ;;
    --paddle-model-source) PADDLE_MODEL_SOURCE_VALUE="$2"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --no-open) NO_OPEN=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --agent-output) AGENT_OUTPUT="$2"; shift 2 ;;
    --install-mode) INSTALL_MODE="${2^^}"; shift 2 ;;
    --allow-provider-replace) ALLOW_PROVIDER_REPLACE=1; shift ;;
    *) echo "Unknown argument / 未知参数: $1" >&2; exit 2 ;;
  esac
done

notify() {
  local message="$1"
  echo "$message"
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v zenity >/dev/null 2>&1; then
    zenity --info --title="OKF Obsidian Memory" --text="$message" >/dev/null 2>&1 || true
  fi
}

fail() {
  local message="$1"
  echo "$message" >&2
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v zenity >/dev/null 2>&1; then
    zenity --error --title="OKF Obsidian Memory" --text="$message" >/dev/null 2>&1 || true
  fi
  exit 1
}

case "$INSTALL_MODE" in
  AUTO|REUSE_EXISTING|SIDECAR|ISOLATED) ;;
  *) fail "Invalid install mode / 无效安装模式: $INSTALL_MODE" ;;
esac

select_vault() {
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    fail "--vault is required with --non-interactive / 非交互模式必须提供 --vault。"
  fi
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v zenity >/dev/null 2>&1; then
    zenity --file-selection --directory --title="选择 Obsidian Vault / Select Obsidian Vault" 2>/dev/null || true
    return
  fi
  read -r -p "Obsidian Vault 完整路径 / Full Vault path: " VAULT_INPUT
  printf '%s' "$VAULT_INPUT"
}

install_ffmpeg_if_needed() {
  command -v ffmpeg >/dev/null 2>&1 && return
  echo "FFmpeg is missing; the installer will try the system package manager. / 缺少 FFmpeg，安装器将尝试使用系统包管理器。"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y ffmpeg
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y ffmpeg
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm ffmpeg
  else
    fail "Install FFmpeg with your distribution package manager, then rerun install-linux.sh / 请先用发行版包管理器安装 FFmpeg，再重新运行安装器。"
  fi
}

echo ""
echo "OKF Obsidian Memory 0.2.x - Easy Installer / 简易安装器"
echo "The installer will prepare OCR, transcription, BGE-M3, Obsidian and OpenClaw."
echo "安装器将自动准备 OCR、转录、BGE-M3、Obsidian 和 OpenClaw。"
echo ""

if [[ -z "$VAULT" ]]; then VAULT="$(select_vault)"; fi
[[ -n "$VAULT" ]] || fail "No Obsidian Vault was selected / 没有选择 Obsidian Vault。"
mkdir -p "$VAULT"
VAULT="$(cd "$VAULT" && pwd)"

command -v node >/dev/null 2>&1 || fail "Node.js >=24.15.0 LTS is required. Install Node 24 LTS, then rerun / 需要 Node.js >=24.15.0 LTS，请安装后重试。"
node -e "const [a,b,c]=process.versions.node.split('.').map(Number);process.exit(a>24||(a===24&&(b>15||(b===15&&c>=0)))?0:1)" ||
  fail "Node.js >=24.15.0 LTS is required / 需要 Node.js >=24.15.0 LTS。"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: core installation skipped / 试运行：已跳过核心安装。"
else
  command -v systemctl >/dev/null 2>&1 || fail "A systemd user session is required for unattended BGE-M3 and OpenClaw services / 无人值守运行需要 systemd 用户会话。"
  systemctl --user show-environment >/dev/null 2>&1 || fail "The systemd user session is not available. Log in as the desktop user and rerun / systemd 用户会话不可用，请以桌面用户登录后重试。"
  install_ffmpeg_if_needed
  BOOTSTRAP_ARGS=(--vault "$VAULT" --install-service --install-mode "$INSTALL_MODE" --network-profile "$NETWORK_PROFILE")
  [[ -n "$NPM_REGISTRY_VALUE" ]] && BOOTSTRAP_ARGS+=(--npm-registry "$NPM_REGISTRY_VALUE")
  [[ -n "$PIP_INDEX_URL_VALUE" ]] && BOOTSTRAP_ARGS+=(--pip-index-url "$PIP_INDEX_URL_VALUE")
  [[ -n "$HF_ENDPOINT_VALUE" ]] && BOOTSTRAP_ARGS+=(--hf-endpoint "$HF_ENDPOINT_VALUE")
  [[ -n "$MODEL_HUB_VALUE" ]] && BOOTSTRAP_ARGS+=(--model-hub "$MODEL_HUB_VALUE")
  [[ -n "$PADDLE_MODEL_SOURCE_VALUE" ]] && BOOTSTRAP_ARGS+=(--paddle-model-source "$PADDLE_MODEL_SOURCE_VALUE")
  [[ "$ALLOW_PROVIDER_REPLACE" == "1" ]] && BOOTSTRAP_ARGS+=(--allow-provider-replace)
  bash "$ROOT/scripts/bootstrap_linux.sh" "${BOOTSTRAP_ARGS[@]}"
fi

AGENT_FILE="${AGENT_OUTPUT:-$ROOT/AGENT_HANDOFF.md}"
node "$ROOT/scripts/generate_agent_handoff.js" \
  --root "$ROOT" \
  --vault "$VAULT" \
  --platform "Linux" \
  --output "$AGENT_FILE"

notify "安装完成。用 Obsidian 打开：$VAULT

只需把这一个文件复制给 Agent：$AGENT_FILE"

if [[ "$NO_OPEN" != "1" && -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$AGENT_FILE" >/dev/null 2>&1 || true
fi
