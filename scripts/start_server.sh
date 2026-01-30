#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

if is_server_running; then
  echo "[start-server] Server already running (PID $(cat "$PID_FILE"))"
  exit 0
fi

# Security: Disable dev mode test user if not in dev mode
SCRIPTS_DIR="$(dirname "${BASH_SOURCE[0]}")"
"$SCRIPTS_DIR/_disable_dev_user.sh"

echo "[start-server] Launching server (logs -> $LOG_FILE)"
nohup npm start >>"$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" >"$PID_FILE"
sleep 1

if ps -p "$pid" >/dev/null 2>&1; then
  echo "[start-server] Server started with PID $pid"
else
  echo "[start-server] Failed to start server; see logs." >&2
  rm -f "$PID_FILE"
  exit 1
fi
