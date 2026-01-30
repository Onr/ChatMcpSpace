#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

echo "[start-production] Preparing production environment..."

# Ensure .env exists; prefer production template if available.
if [ ! -f ".env" ]; then
  if [ -f ".env.production.example" ]; then
    cp .env.production.example .env
    echo "[start-production] Created .env from .env.production.example"
  elif [ -f ".env.example" ]; then
    cp .env.example .env
    echo "[start-production] Created .env from .env.example (production template missing)"
  else
    echo "[start-production] No env template found; create .env manually." >&2
  fi
else
  echo "[start-production] .env already present; using existing values"
fi

# Ensure PID file is writable/clear any stale root-owned file
if [ -f "$PID_FILE" ] && [ ! -w "$PID_FILE" ]; then
  echo "[start-production] Removing stale PID file with elevated permissions"
  sudo rm -f "$PID_FILE"
fi

if is_server_running; then
  echo "[start-production] Server already running (PID $(cat "$PID_FILE"))"
  exit 0
fi

echo "[start-production] Ensuring Node.js dependencies..."
if [ -d "node_modules" ]; then
  echo "[start-production] Dependencies already installed."
else
  npm install
fi

# Verify database connection before starting
echo "[start-production] Verifying database connection..."
SCRIPTS_DIR="$(dirname "${BASH_SOURCE[0]}")"
if "$SCRIPTS_DIR/verify_db.sh"; then
  echo "[start-production] Database connection verified."
else
  echo "[start-production] ✗ Database connection failed!" >&2
  exit 1
fi

# SECURITY: Disable dev mode test user if it exists
echo "[start-production] Checking for dev mode test user..."
"$SCRIPTS_DIR/_disable_dev_user.sh"

# Helper to read an env value from .env (simple parser)
get_env_value() {
  local key="$1"
  if [ -f ".env" ]; then
    grep -E "^${key}=" .env | tail -n1 | cut -d= -f2-
  fi
}

# Determine listening port to decide if sudo is needed (<1024)
port="$(get_env_value PORT)"
https_port="$(get_env_value HTTPS_PORT)"
https_enabled="$(get_env_value HTTPS_ENABLED | tr '[:upper:]' '[:lower:]')"

target_port="$port"
if [ "$https_enabled" = "true" ] && [ -n "$https_port" ]; then
  target_port="$https_port"
fi
if [ -z "$target_port" ]; then
  target_port="3000"
fi

needs_sudo="false"
if [ "$target_port" -lt 1024 ] && [ "$EUID" -ne 0 ]; then
  needs_sudo="true"
fi

# Stop any existing node server listening on the target port to avoid EADDRINUSE
existing_pid="$(sudo lsof -t -i TCP:"$target_port" -sTCP:LISTEN -a -c node 2>/dev/null | head -n1 || true)"
if [ -n "$existing_pid" ]; then
  echo "[start-production] Stopping existing node server on port $target_port (PID $existing_pid)"
  sudo kill "$existing_pid" || true
  sleep 1
  rm -f "$PID_FILE"
fi

echo "[start-production] Starting server on port $target_port with NODE_ENV=production (logs -> $LOG_FILE)"

if [ "$needs_sudo" = "true" ]; then
  sudo env NODE_ENV=production nohup npm start >>"$LOG_FILE" 2>&1 &
  start_pid=$!
  sleep 2
  # Resolve actual node PID (sudo spawns a child)
  node_pid="$(pgrep -n -f "node server.js" || true)"
  if [ -z "$node_pid" ]; then
    echo "[start-production] Failed to start server (port $target_port)" >&2
    exit 1
  fi
  echo "$node_pid" > "$PID_FILE"
  echo "[start-production] Server started with PID $node_pid (sudo)"
else
  nohup env NODE_ENV=production npm start >>"$LOG_FILE" 2>&1 &
  start_pid=$!
  echo "$start_pid" > "$PID_FILE"
  sleep 1
  if ps -p "$start_pid" >/dev/null 2>&1; then
    echo "[start-production] Server started with PID $start_pid"
  else
    echo "[start-production] Failed to start server; see logs." >&2
    rm -f "$PID_FILE"
    exit 1
  fi
fi
