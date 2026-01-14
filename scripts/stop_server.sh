#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

stopped=false

# First, try to stop using PID file
if is_server_running; then
  pid="$(cat "$PID_FILE")"
  echo "[stop-server] Stopping PID $pid from PID file"
  kill "$pid" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
  stopped=true
fi

# Also kill any node server.js processes
if pgrep -f "node server.js" >/dev/null 2>&1; then
  echo "[stop-server] Killing node server.js processes"
  pkill -f "node server.js" 2>/dev/null || true
  stopped=true
fi

# Also kill any processes on port 3000
if command -v lsof >/dev/null 2>&1; then
  port_pids=$(lsof -ti:3000 2>/dev/null || true)
  if [ -n "$port_pids" ]; then
    echo "[stop-server] Killing processes on port 3000: $port_pids"
    echo "$port_pids" | xargs kill -9 2>/dev/null || true
    stopped=true
  fi
fi

# Clean up PID file if it exists
rm -f "$PID_FILE"

if [ "$stopped" = true ]; then
  echo "[stop-server] Server stopped successfully."
else
  echo "[stop-server] No running server found."
fi
