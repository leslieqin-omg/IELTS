#!/bin/bash
# IELTS Practice (IELTS Atlas) 启动脚本
PROJECT_DIR="$(cd "$(dirname "$0")/IELTS-practice" && pwd)"
PORT=8000

echo "=== IELTS Practice (IELTS Atlas) ==="
echo "项目路径: $PROJECT_DIR"
echo ""
echo "正在启动本地静态服务器 (端口: $PORT)..."
echo "浏览器访问: http://localhost:$PORT/"
echo "背词伴侣访问: http://localhost:$PORT/vocab-companion/"
echo "提示: 如需停止服务，请按 Ctrl + C"
echo ""

if command -v open >/dev/null 2>&1; then
    (sleep 1 && open "http://localhost:$PORT/") &
fi

cd "$PROJECT_DIR" || exit 1
python3 -m http.server $PORT

