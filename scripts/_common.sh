#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$ROOT_DIR/server.log"
PID_DIR="$ROOT_DIR/tmp"
PID_FILE="$PID_DIR/server.pid"

mkdir -p "$PID_DIR"

is_server_running() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if ps -p "$pid" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}
