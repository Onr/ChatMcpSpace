#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$ROOT_DIR/server.log"
PID_DIR="$ROOT_DIR/tmp"
PID_FILE="$PID_DIR/server.pid"

mkdir -p "$PID_DIR"

load_nvm_from_dir() {
  local dir="${1:-}"
  if [ -z "$dir" ] || [ ! -s "$dir/nvm.sh" ]; then
    return 1
  fi

  export NVM_DIR="$dir"
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || return 1
  nvm use --silent default >/dev/null 2>&1 || true
  return 0
}

load_nvm_if_available() {
  if load_nvm_from_dir "${NVM_DIR:-}"; then
    return
  fi

  if load_nvm_from_dir "$HOME/.nvm"; then
    return
  fi

  if [ -n "${SUDO_USER:-}" ]; then
    local sudo_home
    sudo_home="$(getent passwd "$SUDO_USER" | cut -d: -f6 2>/dev/null || true)"
    if load_nvm_from_dir "$sudo_home/.nvm"; then
      return
    fi
  fi
}

ensure_supported_node() {
  local min_major="${1:-16}"
  local major="0"

  if ! command -v node >/dev/null 2>&1; then
    load_nvm_if_available
  fi

  if command -v node >/dev/null 2>&1; then
    major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
  fi

  if [ "$major" -lt "$min_major" ]; then
    load_nvm_if_available
    if command -v node >/dev/null 2>&1; then
      major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
    fi
  fi

  if [ "$major" -lt "$min_major" ]; then
    echo "[runtime] ERROR: Node.js ${min_major}+ is required. Current: $(node -v 2>/dev/null || echo 'not found')" >&2
    echo "[runtime] Hint: load nvm and run a modern version (e.g. nvm use 22)." >&2
    exit 1
  fi
}

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
