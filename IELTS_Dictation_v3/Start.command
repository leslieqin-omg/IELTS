#!/bin/bash

set -e
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  osascript -e 'display alert "未找到 Python 3" message "请先从 python.org 安装 Python 3，然后重新启动。"'
  exit 1
fi

./start.sh &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:8766/ >/dev/null; then
    open http://127.0.0.1:8766/
    break
  fi
  sleep 1
done

wait "$SERVER_PID"
