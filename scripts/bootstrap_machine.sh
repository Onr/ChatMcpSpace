#!/usr/bin/env bash

# One-shot bootstrap: install system deps, prepare env, install npm deps,
# start Redis, set up Postgres, and launch the app server.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

APT_UPDATED=0
SCRIPTS_DIR="$ROOT_DIR/scripts"

require_gum() {
  if ! command -v gum >/dev/null 2>&1; then
    echo "[bootstrap] ERROR: gum CLI is required for interactive configuration." >&2
    echo "Install instructions: https://github.com/charmbracelet/gum#installation" >&2
    exit 1
  fi
}

apt_install() {
  local pkg="$1"
  if [ "$APT_UPDATED" -eq 0 ]; then
    echo "[bootstrap] Updating apt cache..."
    sudo apt-get update -y
    APT_UPDATED=1
  fi
  echo "[bootstrap] Installing package: $pkg"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$pkg"
}

ensure_command() {
  local cmd="$1"
  local pkg="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "[bootstrap] $cmd already available."
  else
    apt_install "$pkg"
  fi
}

ensure_env_file() {
  if [ -f ".env" ]; then
    echo "[bootstrap] .env already present."
    return
  fi
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "[bootstrap] Created .env from .env.example."
  else
    touch .env
    echo "[bootstrap] Created empty .env (no template found)."
  fi
}

set_session_secret() {
  local secret_line
  secret_line="$(grep '^SESSION_SECRET=' .env || true)"
  if [ -z "$secret_line" ] || [[ "$secret_line" == *"your_session_secret_key_here"* ]]; then
    local new_secret
    new_secret="$(openssl rand -hex 32)"
    if grep -q '^SESSION_SECRET=' .env; then
      sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$new_secret|" .env
    else
      echo "SESSION_SECRET=$new_secret" >> .env
    fi
    echo "[bootstrap] Set SESSION_SECRET."
  else
    echo "[bootstrap] SESSION_SECRET already set."
  fi
}

get_env_value() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" .env 2>/dev/null || true)"
  if [ -n "$line" ]; then
    echo "${line#*=}"
  fi
}

update_env() {
  local key="$1"
  local value="$2"
  if grep -q "^$key=" .env; then
    sed -i "s|^$key=.*|$key=$value|" .env
  else
    echo "$key=$value" >> .env
  fi
}

prompt_value() {
  local key="$1"
  local prompt="$2"
  local default_val="$3"
  local current
  current="$(get_env_value "$key")"
  local initial="${current:-$default_val}"
  local input
  input="$(gum input --prompt "$prompt: " --value "$initial")"
  if [ -z "$input" ]; then
    input="$initial"
  fi
  update_env "$key" "$input"
  echo "[bootstrap] Set $key=$input"
}

prompt_bool() {
  local key="$1"
  local prompt="$2"
  local default_val="$3"
  local current
  current="$(get_env_value "$key")"
  local initial="${current:-$default_val}"
  local choice
  choice="$(gum choose --cursor "➤ " "true" "false" --header "$prompt (current: $initial)")"
  update_env "$key" "$choice"
  echo "[bootstrap] Set $key=$choice"
}

configure_interactive() {
  gum style --foreground 212 --bold "[bootstrap] Configure environment values"
  prompt_value "PORT" "HTTP port" "${PORT:-3000}"
  prompt_value "BASE_URL" "Base URL" "${BASE_URL:-http://localhost:3000}"
  local node_env_default="${NODE_ENV:-development}"
  local node_env_choice
  node_env_choice="$(gum choose --cursor "➤ " "development" "production" --header "NODE_ENV (current: ${node_env_default})")"
  update_env "NODE_ENV" "$node_env_choice"
  echo "[bootstrap] Set NODE_ENV=$node_env_choice"

  prompt_bool "HTTPS_ENABLED" "Enable HTTPS" "${HTTPS_ENABLED:-false}"
  if [ "$(get_env_value "HTTPS_ENABLED")" = "true" ]; then
    prompt_value "HTTPS_PORT" "HTTPS port" "${HTTPS_PORT:-3443}"
    prompt_value "HTTPS_KEY_PATH" "Path to TLS key" "${HTTPS_KEY_PATH:-./keys/localhost-key.pem}"
    prompt_value "HTTPS_CERT_PATH" "Path to TLS cert" "${HTTPS_CERT_PATH:-./keys/localhost-cert.pem}"
    prompt_value "HTTPS_CA_PATH" "Path to TLS CA (optional)" "${HTTPS_CA_PATH:-}"
    prompt_value "HTTPS_PASSPHRASE" "TLS key passphrase (optional)" "${HTTPS_PASSPHRASE:-}"
  fi
  prompt_bool "ENABLE_HTTP_REDIRECT" "Redirect HTTP to HTTPS" "${ENABLE_HTTP_REDIRECT:-false}"
  prompt_value "HTTP_REDIRECT_PORT" "HTTP redirect port" "${HTTP_REDIRECT_PORT:-3000}"

  if gum confirm "Configure email (SMTP) settings now?"; then
    prompt_value "EMAIL_HOST" "SMTP host" "${EMAIL_HOST:-smtp.gmail.com}"
    prompt_value "EMAIL_PORT" "SMTP port" "${EMAIL_PORT:-587}"
    prompt_bool "EMAIL_SECURE" "Use TLS for SMTP" "${EMAIL_SECURE:-false}"
    prompt_value "EMAIL_USER" "SMTP username" "${EMAIL_USER:-}"
    prompt_value "EMAIL_PASSWORD" "SMTP password/app password" "${EMAIL_PASSWORD:-}"
    prompt_value "EMAIL_FROM" "From email" "${EMAIL_FROM:-noreply@yourdomain.com}"
    prompt_value "EMAIL_FROM_NAME" "From name" "${EMAIL_FROM_NAME:-Agent Messaging Platform}"
    prompt_value "EMAIL_REPLY_TO" "Reply-to email" "${EMAIL_REPLY_TO:-support@yourdomain.com}"
  fi
}

echo "=================================================="
echo "[bootstrap] Installing system prerequisites..."
ensure_command "psql" "postgresql-client"
ensure_command "createdb" "postgresql-client"
ensure_command "pg_dump" "postgresql-client"
ensure_command "postgres" "postgresql"
ensure_command "redis-server" "redis-server"
ensure_command "redis-cli" "redis-tools"
ensure_command "nginx" "nginx"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[bootstrap] WARNING: node/npm missing. Install Node.js (e.g., via nvm) before running the app."
fi

echo "[bootstrap] Preparing environment file..."
ensure_env_file
set_session_secret
require_gum
configure_interactive

echo "[bootstrap] Installing npm dependencies..."
npm install

echo "[bootstrap] Running npm audit fix (best-effort)..."
if ! npm audit fix; then
  echo "[bootstrap] npm audit fix failed or requires network; continuing bootstrap." >&2
fi

echo "[bootstrap] Starting Redis..."
bash "$SCRIPTS_DIR/start_redis.sh"

echo "[bootstrap] Setting up PostgreSQL and schema..."
bash "$SCRIPTS_DIR/run_db_setup.sh"

echo "[bootstrap] Configuring Nginx reverse proxy..."
bash "$SCRIPTS_DIR/setup_nginx_reverse_proxy.sh"

echo "[bootstrap] Starting server in background..."
bash "$SCRIPTS_DIR/start_server.sh"

echo "=================================================="
echo "[bootstrap] Completed. Check status with scripts/server_status.sh"
