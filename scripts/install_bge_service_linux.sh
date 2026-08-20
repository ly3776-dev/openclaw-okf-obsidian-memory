#!/usr/bin/env bash
set -euo pipefail
HF_ENDPOINT_VALUE=""
NO_START=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hf-endpoint) HF_ENDPOINT_VALUE="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    *) echo "Unknown argument / 未知参数: $1" >&2; exit 2 ;;
  esac
done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$ROOT/.venv/bin/python"
[[ -x "$PYTHON" ]] || { echo ".venv is missing / 缺少 .venv" >&2; exit 1; }
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/okf-bge-m3.service"
[[ ! -e "$UNIT" ]] || { echo "Existing systemd unit will not be overwritten / 已有 systemd unit，不会覆盖: $UNIT" >&2; exit 1; }
mkdir -p "$UNIT_DIR"
escape_systemd() {
  local value="${1//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}
escape_systemd_path() {
  local value="${1//\\/\\\\}"
  value="${value// /\\x20}"
  value="${value//$'\t'/\\x09}"
  printf '%s' "$value"
}
ROOT_ESCAPED="$(escape_systemd "$ROOT")"
ROOT_WORKING_ESCAPED="$(escape_systemd_path "$ROOT")"
PYTHON_ESCAPED="$(escape_systemd "$PYTHON")"
HF_ENDPOINT_ESCAPED="$(escape_systemd "$HF_ENDPOINT_VALUE")"
cat >"$UNIT" <<EOF
[Unit]
Description=OKF BGE-M3 embedding service / OKF BGE-M3 向量服务
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT_WORKING_ESCAPED
ExecStart="$PYTHON_ESCAPED" "$ROOT_ESCAPED/scripts/run_bge_m3_supervisor.py" --python "$PYTHON_ESCAPED"
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
Environment="HF_ENDPOINT=$HF_ENDPOINT_ESCAPED"

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable okf-bge-m3.service
if [[ "$NO_START" != "1" ]]; then systemctl --user restart okf-bge-m3.service; fi
echo "systemd user service installed / 已安装 systemd 用户服务: $UNIT"
echo "Logs / 日志: $ROOT/.logs"
