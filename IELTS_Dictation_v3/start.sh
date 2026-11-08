#!/usr/bin/env bash
# ==============================================================================
# IELTS_Dictation_v2 — Startup Script
# ==============================================================================
# Standalone startup script for IELTS_Dictation_v2.
# Runs on port 8766, completely isolated from IELTS_Dictation (port 8765).
# ==============================================================================

set -e

# Resolve script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Validate Python 3 is available
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: python3 is required but was not found in PATH." >&2
    exit 1
fi

PORT="${PORT:-8766}"
HOST="${HOST:-127.0.0.1}"

# Optional restart flag: terminate existing processes on target port
if [[ "$1" == "--restart" || "$1" == "-r" ]]; then
    echo "[*] Restart flag detected. Checking port $PORT..."
    EXISTING_PID=$(lsof -ti :"$PORT" 2>/dev/null || true)
    if [[ -n "$EXISTING_PID" ]]; then
        echo "[*] Terminating existing process on port $PORT (PID: $EXISTING_PID)..."
        kill -9 $EXISTING_PID 2>/dev/null || true
        sleep 0.5
    fi
fi

echo "==========================================================================="
echo " IELTS_Dictation_v2 — One-Click Startup"
echo "==========================================================================="
echo " Target Port : $PORT (distinct from v1 on 8765)"
echo " Host        : $HOST"
echo " Directory   : $SCRIPT_DIR"
echo " Python      : $(python3 --version 2>&1)"
echo "==========================================================================="

exec python3 server.py "$@"
