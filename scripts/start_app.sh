#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

echo "[start-app] Checking environment configuration..."
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "[start-app] Created .env from template."
  else
    echo "[start-app] WARNING: .env.example missing; create .env manually." >&2
  fi
else
  echo "[start-app] .env already exists."
fi

echo "[start-app] Ensuring Node.js dependencies..."
if [ -d "node_modules" ]; then
  echo "[start-app] Dependencies already installed."
else
  npm install
fi

# Ensure PostgreSQL is running
echo "[start-app] Checking if PostgreSQL is running..."
if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  echo "[start-app] PostgreSQL is not running. Starting it now..."
  if sudo service postgresql start; then
    echo "[start-app] PostgreSQL started successfully."
    sleep 2  # Give PostgreSQL a moment to fully start
  else
    echo "[start-app] ✗ Failed to start PostgreSQL!" >&2
    echo "[start-app] Please start PostgreSQL manually: sudo service postgresql start" >&2
    exit 1
  fi
else
  echo "[start-app] PostgreSQL is already running."
fi

# Ensure Redis is running
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
echo "[start-app] Checking if Redis is running on ${REDIS_HOST}:${REDIS_PORT}..."
if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  echo "[start-app] Redis is already running."
else
  echo "[start-app] Redis is not running. Starting it now..."
  if redis-server --bind "$REDIS_HOST" --port "$REDIS_PORT" --daemonize yes --save "" --appendonly no; then
    sleep 1
    if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
      echo "[start-app] Redis started successfully."
    else
      echo "[start-app] ⚠ Redis may not have started correctly. Continuing anyway..." >&2
    fi
  else
    echo "[start-app] ⚠ Failed to start Redis. The app may still work without it." >&2
  fi
fi

# Verify database connection before starting
echo "[start-app] Verifying database connection..."
SCRIPTS_DIR="$(dirname "${BASH_SOURCE[0]}")"
if "$SCRIPTS_DIR/verify_db.sh"; then
  echo "[start-app] Database connection verified."
else
  echo "[start-app] ✗ Database connection failed!" >&2
  echo "[start-app] To fix this issue, you have two options:" >&2
  echo "[start-app]   1. Run 'fix_db' from the main CLI menu (quick fix)" >&2
  echo "[start-app]   2. Run 'db' from the main CLI menu (full setup)" >&2
  exit 1
fi

echo "[start-app] Launching npm start (foreground). Press Ctrl+C to stop."
npm start
