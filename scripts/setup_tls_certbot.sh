#!/usr/bin/env bash

# Obtain a Let's Encrypt certificate using certbot (standalone) and
# update .env to enable in-app TLS termination.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

prompt() {
  local message="$1" default="${2:-}"
  local value
  read -rp "$message" value
  if [ -z "$value" ] && [ -n "$default" ]; then
    value="$default"
  fi
  echo "$value"
}

set_env_value() {
  local key="$1" value="$2" env_file="$ROOT_DIR/.env"
  touch "$env_file"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    echo "${key}=${value}" >>"$env_file"
  fi
}

echo "[tls-setup] Let's collect a few details."
DOMAIN="$(prompt "Primary domain [chatmcp.space]: " "chatmcp.space")"
ADD_WWW="$(prompt "Add www.${DOMAIN} as an alternate domain? (y/N): " "N")"
ADMIN_EMAIL="$(prompt "Email for Let's Encrypt notices (required): " "")"
while [ -z "$ADMIN_EMAIL" ]; do
  ADMIN_EMAIL="$(prompt "Email cannot be empty. Enter email: " "")"
done

ENABLE_REDIRECT_INPUT="$(prompt "Enable HTTP -> HTTPS redirect inside the app? (Y/n): " "Y")"
HTTPS_PORT="$(prompt "HTTPS port to listen on [443]: " "443")"
HTTP_REDIRECT_PORT="$(prompt "HTTP port for redirect listener [80]: " "80")"

ENABLE_REDIRECT="false"
if [[ "${ENABLE_REDIRECT_INPUT,,}" =~ ^y ]]; then
  ENABLE_REDIRECT="true"
fi

DOMAINS_ARGS=(-d "$DOMAIN")
if [[ "${ADD_WWW,,}" =~ ^y ]]; then
  DOMAINS_ARGS+=(-d "www.${DOMAIN}")
fi

echo "[tls-setup] Installing certbot if missing (requires sudo)..."
if ! command -v certbot >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y certbot
else
  echo "[tls-setup] certbot already installed."
fi

RESTART_NGINX="false"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
  echo "[tls-setup] nginx is running and may occupy port 80; stopping temporarily..."
  sudo systemctl stop nginx
  RESTART_NGINX="true"
elif command -v service >/dev/null 2>&1 && service nginx status >/dev/null 2>&1; then
  echo "[tls-setup] nginx is running and may occupy port 80; stopping temporarily..."
  sudo service nginx stop
  RESTART_NGINX="true"
fi

echo "[tls-setup] Requesting certificate for ${DOMAIN}..."
sudo certbot certonly --standalone \
  --non-interactive --agree-tos \
  --email "$ADMIN_EMAIL" \
  --expand \
  "${DOMAINS_ARGS[@]}"

if [ "$RESTART_NGINX" = "true" ]; then
  echo "[tls-setup] Restarting nginx..."
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl start nginx
  else
    sudo service nginx start
  fi
fi

CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
KEY_PATH="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"

echo "[tls-setup] Updating .env with TLS settings..."
set_env_value "BASE_URL" "https://${DOMAIN}"
set_env_value "HTTPS_ENABLED" "true"
set_env_value "HTTPS_PORT" "$HTTPS_PORT"
set_env_value "HTTPS_CERT_PATH" "$CERT_PATH"
set_env_value "HTTPS_KEY_PATH" "$KEY_PATH"
set_env_value "ENABLE_HTTP_REDIRECT" "$ENABLE_REDIRECT"
set_env_value "HTTP_REDIRECT_PORT" "$HTTP_REDIRECT_PORT"

echo "[tls-setup] Certificate obtained. TLS paths:"
echo "  Key : $KEY_PATH"
echo "  Cert: $CERT_PATH"
echo "[tls-setup] Ensure your process manager restarts the app to pick up the new certs."
echo "[tls-setup] Renewal is handled by certbot's timer; add a deploy hook to restart the app after renewals if needed."
