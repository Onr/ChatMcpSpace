#!/usr/bin/env bash

# Start local PostgreSQL and Redis services and ensure .env has local defaults.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

ensure_env_file() {
  if [ -f ".env" ]; then
    return
  fi
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "[start-local-stack] Created .env from template."
  else
    touch .env
    echo "[start-local-stack] Created empty .env (no template found)."
  fi
}

get_env_value() {
  local key="$1"
  if [ ! -f ".env" ]; then
    return
  fi
  grep -E "^${key}=" .env | tail -n 1 | cut -d'=' -f2-
}

set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

ensure_env_defaults() {
  ensure_env_file
  local db_user db_pass db_name db_host db_port
  db_user="$(get_env_value "DB_USER")"
  db_pass="$(get_env_value "DB_PASSWORD")"
  db_name="$(get_env_value "DB_NAME")"
  db_host="$(get_env_value "DB_HOST")"
  db_port="$(get_env_value "DB_PORT")"

  if [ -z "$db_host" ] || [ "$db_host" = "localhost" ]; then
    set_env_value "DB_HOST" "127.0.0.1"
  fi
  if [ -z "$db_port" ]; then
    set_env_value "DB_PORT" "5432"
  fi
  if [ -z "$db_name" ] || [ "$db_name" = "agent_messaging_platform" ]; then
    set_env_value "DB_NAME" "agent_messaging_platform"
  fi
  if [ -z "$db_user" ] || [ "$db_user" = "your_db_user" ]; then
    set_env_value "DB_USER" "postgres"
  fi
  if [ -z "$db_pass" ] || [ "$db_pass" = "your_db_password" ]; then
    set_env_value "DB_PASSWORD" ""
  fi

  # Redis defaults
  local redis_host redis_port
  redis_host="$(get_env_value "REDIS_HOST")"
  redis_port="$(get_env_value "REDIS_PORT")"
  [ -z "$redis_host" ] && set_env_value "REDIS_HOST" "127.0.0.1"
  [ -z "$redis_port" ] && set_env_value "REDIS_PORT" "6379"
  local redis_url
  redis_url="$(get_env_value "REDIS_URL")"
  if [ -z "$redis_url" ]; then
    set_env_value "REDIS_URL" "redis://127.0.0.1:6379"
  fi
  [ -z "$(get_env_value "REDIS_DB")" ] && set_env_value "REDIS_DB" "0"
  [ -z "$(get_env_value "REDIS_SESSION_DB")" ] && set_env_value "REDIS_SESSION_DB" "0"
  [ -z "$(get_env_value "REDIS_RATE_DB")" ] && set_env_value "REDIS_RATE_DB" "1"
}

start_postgres() {
  echo "[start-local-stack] Starting PostgreSQL (requires sudo)..."
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl start postgresql
  else
    sudo service postgresql start
  fi
  sleep 2
  if command -v pg_isready >/dev/null 2>&1; then
    if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
      echo "[start-local-stack] PostgreSQL did not report ready on 127.0.0.1:5432." >&2
      exit 1
    fi
  fi
  echo "[start-local-stack] PostgreSQL running."
}

echo "[start-local-stack] Ensuring .env has local DB/Redis defaults..."
ensure_env_defaults

start_postgres

echo "[start-local-stack] Starting Redis..."
"$ROOT_DIR/scripts/start_redis.sh"

echo "[start-local-stack] Local services ready. Updated .env with defaults where missing."
