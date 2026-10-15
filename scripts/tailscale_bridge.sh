#!/usr/bin/env bash

# Expose the local ChatMCP server privately through Tailscale Serve.
# This uses Tailscale's HTTPS reverse proxy and never enables Funnel.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

read_env_value() {
  local key="$1"
  local value=""

  if [ -f "$ROOT_DIR/.env" ]; then
    value="$(awk -F= -v wanted="$key" '$1 == wanted {sub(/^[^=]*=/, ""); print; exit}' "$ROOT_DIR/.env")"
  fi

  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  printf '%s' "$value"
}

usage() {
  cat <<'EOF'
Usage: scripts/tailscale_bridge.sh <command>

Commands:
  up       Proxy the local ChatMCP server through Tailscale Serve over HTTPS.
  status   Show Tailscale and Serve status.

Environment:
  TAILSCALE_APP_PORT  Local app port (defaults to PORT, then .env PORT, then 3000).
EOF
}

require_tailscale() {
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "[tailscale-bridge] Tailscale CLI is not installed or is not on PATH." >&2
    echo "[tailscale-bridge] Install Tailscale, sign in, and reconnect this machine first." >&2
    exit 1
  fi

  if ! tailscale status >/dev/null 2>&1 || ! tailscale ip -4 >/dev/null 2>&1; then
    echo "[tailscale-bridge] Tailscale is not connected on this machine." >&2
    echo "[tailscale-bridge] Run 'tailscale up' and complete sign-in, then retry." >&2
    exit 1
  fi
}

app_port="${TAILSCALE_APP_PORT:-${PORT:-}}"
if [ -z "$app_port" ]; then
  app_port="$(read_env_value PORT)"
fi
app_port="${app_port:-3000}"

case "${1:-}" in
  up)
    require_tailscale

    if ! [[ "$app_port" =~ ^[0-9]+$ ]] || [ "$app_port" -lt 1 ] || [ "$app_port" -gt 65535 ]; then
      echo "[tailscale-bridge] Invalid app port: $app_port" >&2
      exit 1
    fi

    if ! curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${app_port}/" >/dev/null; then
      echo "[tailscale-bridge] ChatMCP is not responding on 127.0.0.1:${app_port}." >&2
      echo "[tailscale-bridge] Start the app first, then run this command again." >&2
      exit 1
    fi

    echo "[tailscale-bridge] Configuring private HTTPS access to 127.0.0.1:${app_port}..."
    tailscale serve --bg --yes "http://127.0.0.1:${app_port}"

    echo
    echo "[tailscale-bridge] Serve configuration:"
    tailscale serve status
    echo
    echo "[tailscale-bridge] The app is now reachable only by devices allowed in your tailnet."
    echo "[tailscale-bridge] Set BASE_URL to the HTTPS hostname printed above, then restart ChatMCP."
    echo "[tailscale-bridge] Point external connectors at that same URL using CHATSPACE_URL."
    ;;
  status)
    require_tailscale
    tailscale status
    echo
    tailscale serve status
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
