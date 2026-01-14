#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

ensure_env_file() {
  if [ -f ".env" ]; then
    return
  fi

  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "[start-redis] Created .env from template."
  else
    echo "[start-redis] WARNING: .env.example missing; create .env manually." >&2
    touch .env
  fi
}

ensure_env_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" ".env"; then
    echo "[start-redis] ${key} already set."
  else
    echo "${key}=${value}" >> ".env"
    echo "[start-redis] Set ${key}=${value} in .env"
  fi
}

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_URL_DEFAULT="redis://${REDIS_HOST}:${REDIS_PORT}"

if ! command -v redis-server >/dev/null 2>&1; then
  echo "[start-redis] redis-server is not installed. Please install Redis (e.g., sudo apt install redis-server) and re-run." >&2
  exit 1
fi

if ! command -v redis-cli >/dev/null 2>&1; then
  echo "[start-redis] redis-cli is not installed. Please install Redis CLI (usually with redis-server) and re-run." >&2
  exit 1
fi

echo "[start-redis] Checking if Redis is already running on ${REDIS_HOST}:${REDIS_PORT}..."
if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  echo "[start-redis] Redis is already running."
else
  echo "[start-redis] Starting redis-server on ${REDIS_HOST}:${REDIS_PORT}..."
  redis-server --bind "$REDIS_HOST" --port "$REDIS_PORT" --daemonize yes --save "" --appendonly no
  sleep 1
  if ! redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    echo "[start-redis] Failed to start redis-server. Check system logs." >&2
    exit 1
  fi
  echo "[start-redis] Redis started."
fi

echo "[start-redis] Ensuring .env has Redis defaults..."
ensure_env_file
ensure_env_var "REDIS_URL" "$REDIS_URL_DEFAULT"
ensure_env_var "REDIS_HOST" "$REDIS_HOST"
ensure_env_var "REDIS_PORT" "$REDIS_PORT"
ensure_env_var "REDIS_DB" "0"
ensure_env_var "REDIS_SESSION_DB" "0"
ensure_env_var "REDIS_RATE_DB" "1"

echo "[start-redis] Done."
