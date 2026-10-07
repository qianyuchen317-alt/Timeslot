#!/usr/bin/env bash
#
# vllm Mesh —— 唯一启动入口
#
#   ./start.sh start     启动全部服务（已在跑的自动跳过）
#   ./start.sh stop      停止全部服务
#   ./start.sh restart   重启
#   ./start.sh status    查看状态
#   ./start.sh logs      跟踪日志
#
# 端口约定：vLLM=8000  后端=8100  前端=5173
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

export PATH="$HOME/.venv-vllm-metal/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"

VLLM_MODEL="${VLLM_MODEL:-mlx-community/Qwen3.5-9B-MLX-4bit}"
VLLM_MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-32768}"
VLLM_PORT="${VLLM_PORT:-8000}"
API_PORT="${API_PORT:-8100}"
WEB_PORT="${WEB_PORT:-5173}"

port_up()  { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
pid_of()   { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }
say()      { printf '  %s\n' "$*"; }

start_vllm() {
  if port_up "$VLLM_PORT"; then say "vllm    : 已在运行 (:${VLLM_PORT})"; return; fi
  [ -x "$HOME/.venv-vllm-metal/bin/vllm" ] || {
    echo "缺少 vllm-metal：~/.venv-vllm-metal 未安装" >&2; exit 1; }
  say "vllm    : 启动中 (:${VLLM_PORT}) → logs/vllm.log"
  nohup vllm serve "$VLLM_MODEL" --host 127.0.0.1 --port "$VLLM_PORT" \
    --max-model-len "$VLLM_MAX_MODEL_LEN" >"$LOGS/vllm.log" 2>&1 &
  echo $! >"$LOGS/vllm.pid"
}

start_api() {
  if port_up "$API_PORT"; then say "backend : 已在运行 (:${API_PORT})"; return; fi
  cd "$ROOT/backend"
  if [ ! -x .venv/bin/uvicorn ]; then
    say "backend : 初始化依赖"
    uv venv && uv pip install -r requirements.txt
  fi
  say "backend : 启动中 (:${API_PORT}) → logs/backend.log"
  nohup .venv/bin/uvicorn main:app --host 127.0.0.1 --port "$API_PORT" \
    >"$LOGS/backend.log" 2>&1 &
  echo $! >"$LOGS/backend.pid"
}

start_web() {
  if port_up "$WEB_PORT"; then say "frontend: 已在运行 (:${WEB_PORT})"; return; fi
  cd "$ROOT/frontend"
  if [ ! -d node_modules ]; then
    say "frontend: 初始化依赖"
    npm install
  fi
  say "frontend: 启动中 (:${WEB_PORT}) → logs/frontend.log"
  nohup npm run dev -- --host 127.0.0.1 --port "$WEB_PORT" \
    >"$LOGS/frontend.log" 2>&1 &
  echo $! >"$LOGS/frontend.pid"
}

stop_one() {
  local name="$1" port="$2"
  local pids; pids="$(pid_of "$port")"
  if [ -z "$pids" ]; then say "$name: 未运行"; return; fi
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  say "$name: 已停止 (:${port})"
  rm -f "$LOGS/$name.pid"
}

status() {
  for entry in "vllm:$VLLM_PORT" "backend:$API_PORT" "frontend:$WEB_PORT"; do
    local name="${entry%%:*}" port="${entry##*:}"
    if port_up "$port"; then say "$name: 运行中 (:${port})"; else say "$name: 已停止"; fi
  done
}

wait_ready() {
  local port="$1" url="$2" name="$3" i
  for i in $(seq 1 90); do
    if curl -sf "$url" >/dev/null 2>&1; then say "$name: 就绪"; return 0; fi
    sleep 1
  done
  say "$name: 启动超时，见 logs/"; return 1
}

case "${1:-start}" in
  start)
    start_vllm
    start_api
    start_web
    wait_ready "$VLLM_PORT" "http://127.0.0.1:${VLLM_PORT}/v1/models" "vllm   " || true
    wait_ready "$API_PORT"  "http://127.0.0.1:${API_PORT}/api/health"    "backend" || true
    echo
    status
    echo
    say "前端入口: http://127.0.0.1:${WEB_PORT}"
    ;;
  stop)
    stop_one frontend "$WEB_PORT"
    stop_one backend  "$API_PORT"
    stop_one vllm     "$VLLM_PORT"
    ;;
  restart)
    "$0" stop; sleep 1; "$0" start
    ;;
  status)
    status
    ;;
  logs)
    tail -f "$LOGS"/*.log
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs}" >&2
    exit 1
    ;;
esac
