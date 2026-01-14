#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to run the test suite." >&2
  exit 1
fi

cd "$ROOT_DIR"
npm test
