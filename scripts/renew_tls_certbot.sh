#!/usr/bin/env bash

# Renew/reinstall Let's Encrypt certs with nginx, enable auto-renewal,
# install a deploy hook, and verify the live certificate.

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

infer_domain() {
  if [ -n "${BASE_URL:-}" ]; then
    echo "$BASE_URL" | sed -E 's~^[a-zA-Z]+://~~; s~/.*$~~'
    return
  fi
  if [ -f ".env" ]; then
    local env_base
    env_base="$(grep -E '^BASE_URL=' .env 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
    if [ -n "$env_base" ]; then
      echo "$env_base" | sed -E 's~^[a-zA-Z]+://~~; s~/.*$~~'
      return
    fi
  fi
  echo "chatmcp.space"
}

DOMAIN_DEFAULT="$(infer_domain)"
DOMAIN="$(prompt "Primary domain [${DOMAIN_DEFAULT}]: " "$DOMAIN_DEFAULT")"
EMAIL="$(prompt "Email for Let's Encrypt notices [admin@${DOMAIN}]: " "admin@${DOMAIN}")"
ADD_WWW_INPUT="$(prompt "Include www.${DOMAIN}? (Y/n): " "Y")"

DOMAIN_ARGS=(-d "$DOMAIN")
if [[ "${ADD_WWW_INPUT,,}" =~ ^y ]]; then
  DOMAIN_ARGS+=(-d "www.${DOMAIN}")
fi

echo "[tls-renew] Installing certbot + nginx plugin if missing..."
if ! command -v certbot >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y certbot
fi
if ! dpkg -s python3-certbot-nginx >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3-certbot-nginx
fi

NGINX_CONF="/etc/nginx/sites-available/agent-messaging-platform.conf"
if [ -f "$NGINX_CONF" ] && [[ "${ADD_WWW_INPUT,,}" =~ ^y ]]; then
  sudo sed -i -E "s/server_name[[:space:]]+${DOMAIN};/server_name ${DOMAIN} www.${DOMAIN};/" "$NGINX_CONF" || true
  sudo nginx -t
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl reload nginx || true
  else
    sudo service nginx reload || true
  fi
fi

echo "[tls-renew] Existing certificates:"
sudo certbot certificates || true

echo "[tls-renew] Issuing/installing certificate with nginx plugin..."
sudo certbot --nginx \
  "${DOMAIN_ARGS[@]}" \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --redirect

echo "[tls-renew] Ensuring certbot timer is enabled..."
sudo systemctl enable --now certbot.timer
systemctl list-timers --all | grep certbot || true

echo "[tls-renew] Installing deploy hook to reload nginx after renew..."
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null <<'EOF'
#!/bin/sh
set -eu
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
  fi
  if systemctl is-active --quiet agent-messaging-platform.service; then
    systemctl restart agent-messaging-platform.service
  fi
elif command -v service >/dev/null 2>&1; then
  service nginx reload || true
fi
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo "[tls-renew] Running dry-run renewal test (non-fatal if it fails)..."
if ! sudo certbot renew --dry-run; then
  echo "[tls-renew] WARNING: dry-run failed. Check DNS and /.well-known/acme-challenge routing."
fi

# If the app itself owns 443, it must be restarted to load the new cert files.
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet agent-messaging-platform.service; then
  echo "[tls-renew] Restarting agent-messaging-platform.service to load renewed cert..."
  sudo systemctl restart agent-messaging-platform.service
fi

echo "[tls-renew] Live certificate check for ${DOMAIN}:"
echo | openssl s_client -servername "$DOMAIN" -connect "${DOMAIN}:443" 2>/dev/null | \
  openssl x509 -noout -dates -issuer -subject

echo "[tls-renew] Done."
