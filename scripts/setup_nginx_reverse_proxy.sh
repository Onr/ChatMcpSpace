#!/usr/bin/env bash

# Install and configure Nginx as a reverse proxy on port 80,
# forwarding to the local app port (defaults to PORT or 3000).

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

# Load PORT/BASE_URL if .env exists
if [ -f ".env" ]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' .env | sed 's/#.*//' | xargs)
fi

APP_PORT="${PORT:-3000}"
if [ "$APP_PORT" -lt 1024 ]; then
  echo "[nginx-setup] PORT=$APP_PORT is privileged; using 3000 for the upstream app port."
  APP_PORT=3000
fi
MAX_UPLOAD_MB="${MAX_ATTACHMENT_SIZE_MB:-${MAX_IMAGE_SIZE_MB:-20}}"
MAINTENANCE_DIR="${NGINX_MAINTENANCE_DIR:-/var/www/chatmcp-space}"

# Derive a reasonable server_name from BASE_URL if provided
SERVER_NAME="${SERVER_NAME:-_}"
if [ "$SERVER_NAME" = "_" ] && [ -n "${BASE_URL:-}" ]; then
  # Strip protocol and path to get host
  SERVER_NAME="$(echo "$BASE_URL" | sed -E 's~^[a-zA-Z]+://~~; s~/.*$~~')"
fi

# If a concrete domain is configured, include the www alias too.
if [ "$SERVER_NAME" != "_" ] && [[ "$SERVER_NAME" != *" "* ]] && [[ "$SERVER_NAME" != www.* ]]; then
  SERVER_NAME="${SERVER_NAME} www.${SERVER_NAME}"
fi

CONFIG_NAME="agent-messaging-platform.conf"
CONFIG_PATH="/etc/nginx/sites-available/${CONFIG_NAME}"
TMP_CONF="$(mktemp)"
trap 'rm -f "$TMP_CONF"' EXIT

cat >"$TMP_CONF" <<EOF
server {
    listen 80;
    server_name ${SERVER_NAME};

    client_max_body_size ${MAX_UPLOAD_MB}m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_intercept_errors on;
        error_page 502 503 504 =503 /maintenance.html;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300;
    }

    location = /maintenance.html {
        root ${MAINTENANCE_DIR};
        internal;
        add_header Cache-Control "no-store" always;
        add_header Retry-After "20" always;
    }
}
EOF

install_nginx() {
  if command -v nginx >/dev/null 2>&1; then
    echo "[nginx-setup] nginx already installed."
    return
  fi
  echo "[nginx-setup] Installing nginx (requires sudo)..."
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
}

install_nginx

echo "[nginx-setup] Installing the static upstream-outage page in ${MAINTENANCE_DIR}"
sudo install -d -m 755 "$MAINTENANCE_DIR"
sudo install -m 644 public/maintenance.html "$MAINTENANCE_DIR/maintenance.html"

echo "[nginx-setup] Writing config to ${CONFIG_PATH}"
sudo mv "$TMP_CONF" "$CONFIG_PATH"
sudo ln -sf "$CONFIG_PATH" "/etc/nginx/sites-enabled/${CONFIG_NAME}"

# Disable the default site to avoid conflicts
if [ -e "/etc/nginx/sites-enabled/default" ]; then
  sudo rm -f /etc/nginx/sites-enabled/default
fi

echo "[nginx-setup] Testing nginx configuration..."
sudo nginx -t

echo "[nginx-setup] Reloading nginx..."
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl reload nginx
else
  sudo service nginx reload
fi

echo "[nginx-setup] Done. Proxy is listening on :80 and forwarding to 127.0.0.1:${APP_PORT}"
echo "[nginx-setup] Ensure the app server is started on ${APP_PORT} (set PORT in .env accordingly)."
