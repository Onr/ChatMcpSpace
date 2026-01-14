#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

lines="${1:-${TAIL_LINES:-200}}"

if [ ! -f "$LOG_FILE" ]; then
  echo "[follow-logs] Log file not found at $LOG_FILE" >&2
  exit 1
fi

echo "[follow-logs] tail -n $lines -f $LOG_FILE"
tail -n "$lines" -f "$LOG_FILE"
