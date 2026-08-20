#!/usr/bin/env bash
set -euo pipefail
HOST_NAME="${HOST_NAME:-127.0.0.1}"
PORT="${PORT:-8008}"
API_KEY="${API_KEY:-okf-local}"
MODEL="${MODEL:-BAAI/bge-m3}"
DEVICE="${DEVICE:-cpu}"
BACKEND="${BACKEND:-sentence-transformers}"
MODEL_CACHE_DIR="${MODEL_CACHE_DIR:-}"
HF_ENDPOINT_VALUE="${HF_ENDPOINT_VALUE:-}"
INSTALL_DEPS=0
FOREGROUND=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST_NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --backend) BACKEND="$2"; shift 2 ;;
    --model-cache-dir) MODEL_CACHE_DIR="$2"; shift 2 ;;
    --hf-endpoint) HF_ENDPOINT_VALUE="$2"; shift 2 ;;
    --install-deps) INSTALL_DEPS=1; shift ;;
    --foreground) FOREGROUND=1; shift ;;
    *) echo "Unknown argument / 未知参数: $1" >&2; exit 2 ;;
  esac
done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$ROOT/.venv/bin/python"
[[ -x "$PYTHON" ]] || { echo ".venv is missing / 缺少 .venv" >&2; exit 1; }
[[ "$INSTALL_DEPS" == "1" ]] && "$PYTHON" -m pip install -r "$ROOT/requirements-bge-m3.txt"
[[ -n "$HF_ENDPOINT_VALUE" ]] && export HF_ENDPOINT="$HF_ENDPOINT_VALUE"
ARGS=("$ROOT/scripts/run_bge_m3_supervisor.py" --host "$HOST_NAME" --port "$PORT" --api-key "$API_KEY" --model "$MODEL" --device "$DEVICE" --backend "$BACKEND")
[[ -n "$MODEL_CACHE_DIR" ]] && ARGS+=(--model-cache-dir "$MODEL_CACHE_DIR")
if [[ "$FOREGROUND" == "1" ]]; then exec "$PYTHON" "${ARGS[@]}"; fi
mkdir -p "$ROOT/.logs"
nohup "$PYTHON" "${ARGS[@]}" >"$ROOT/.logs/supervisor-launch.out.log" 2>"$ROOT/.logs/supervisor-launch.err.log" &
echo "BGE-M3 supervisor started / BGE-M3 守护进程已启动: pid=$!"
echo "Logs / 日志: $ROOT/.logs"
