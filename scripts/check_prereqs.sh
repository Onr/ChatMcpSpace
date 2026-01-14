#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

CMDS=("node" "npm" "psql" "createdb" "pg_dump")
missing=0

for cmd in "${CMDS[@]}"; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "[check-prereqs] $cmd -> $(command -v "$cmd")"
  else
    echo "[check-prereqs] MISSING: $cmd"
    missing=1
  fi
done

if [ "$missing" -eq 0 ]; then
  echo "[check-prereqs] All commands detected."
else
  echo "[check-prereqs] One or more commands missing." >&2
  exit 1
fi
