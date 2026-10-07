#!/usr/bin/env bash
# 启动 vllm Mesh 后端
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.venv-vllm-metal/bin:/opt/homebrew/bin:$PATH"
if [ ! -d .venv ]; then
  uv venv
  uv pip install -r requirements.txt
fi
exec .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8100 --reload
