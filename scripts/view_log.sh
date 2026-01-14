#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

if [ ! -f "$LOG_FILE" ]; then
  echo "[view-log] Log file not found at $LOG_FILE" >&2
  exit 1
fi

pager="${PAGER:-less}"
echo "[view-log] Opening log with $pager"
"$pager" "$LOG_FILE"
