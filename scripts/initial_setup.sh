#!/usr/bin/env bash

# Initial Setup Script
# Sets up the environment, installs dependencies, and ensures directory structure.

set -euo pipefail

# Load common variables and functions
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

ensure_env_file() {
  if [ -f ".env" ]; then
    echo "[initial-setup] .env already exists"
    return
  fi

  if [ ! -f ".env.example" ]; then
    echo "[initial-setup] WARNING: .env.example missing; please create .env manually." >&2
    return
  fi

  cp .env.example .env
  echo "[initial-setup] Created .env from .env.example"
}

ensure_chatspace() {
  if [ ! -d "chatspace" ]; then
    echo "[initial-setup] Creating chatspace directory..."
    mkdir -p chatspace
  else
    echo "[initial-setup] chatspace directory exists."
  fi
}

# 1. Ensure .env exists
ensure_env_file

# 2. Ensure chatspace directory exists
ensure_chatspace

# 3. Install dependencies
echo "[initial-setup] Installing npm dependencies..."
npm install

# 3b. Fix known vulnerabilities after install (non-blocking)
echo "[initial-setup] Running npm audit fix (best-effort)..."
if ! npm audit fix; then
  echo "[initial-setup] npm audit fix failed or requires network; continuing setup." >&2
fi

# 4. Optional: Run DB setup
if [ "${RUN_DB_SETUP:-false}" = "true" ]; then
  if [ -x "$ROOT_DIR/scripts/run_db_setup.sh" ]; then
    "$ROOT_DIR/scripts/run_db_setup.sh"
  else
    echo "[initial-setup] WARNING: run_db_setup.sh missing or not executable." >&2
  fi
else
  echo "[initial-setup] Skipping database setup (RUN_DB_SETUP != true)"
fi

echo "[initial-setup] Setup complete!"
