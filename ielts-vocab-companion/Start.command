#!/bin/bash
set -euo pipefail

cd -- "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

pause_on_error() {
  if [[ -t 0 ]]; then
    read -r -p "Press Return to close..." _ || true
  fi
}

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "Node.js was not found. Install Node.js LTS from https://nodejs.org/en/download"
  printf '%s\n' "Then reopen this script. See README_MACOS.md for instructions."
  pause_on_error
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 18 || (major === 18 && minor >= 19) ? 0 : 1)'; then
  printf '%s\n' "Node.js 18.19 or newer is required. Install a supported Node.js LTS release."
  pause_on_error
  exit 1
fi

export PORT="${PORT:-47832}"
if ! node -e 'const p = Number(process.env.PORT); process.exit(Number.isInteger(p) && p >= 1 && p <= 65535 ? 0 : 1)'; then
  printf '%s\n' "PORT must be an integer between 1 and 65535."
  pause_on_error
  exit 1
fi

url="http://127.0.0.1:$PORT"
printf '%s\n' "Starting IELTS Vocab Companion at $url"
printf '%s\n' "Keep this Terminal window open. Press Control-C to stop the service."
node server.mjs &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

ready=0
for attempt in {1..50}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    printf '%s\n' "The server could not start. Check the error above and README_MACOS.md."
    pause_on_error
    exit 1
  fi
  if curl --silent --fail --max-time 1 "$url/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
done

if [[ "$ready" != "1" ]]; then
  printf '%s\n' "The server did not become ready. Check PORT and your local network settings."
  pause_on_error
  exit 1
fi

if [[ "${IELTS_NO_OPEN:-0}" != "1" ]] && command -v open >/dev/null 2>&1; then
  open "$url/" || printf '%s\n' "Open $url/ manually in your browser."
else
  printf '%s\n' "Open $url/ manually in your browser."
fi

wait "$server_pid"
