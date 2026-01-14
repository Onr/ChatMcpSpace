#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if ! command -v curl >/dev/null 2>&1; then
  echo "[https-check] curl is required to run this check." >&2
  exit 1
fi

default_url=""
if [ -f "$ENV_FILE" ]; then
  default_url="$(grep -E '^BASE_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d "\"'")"
fi

prompt_for_url() {
  local preset="$1"
  if command -v gum >/dev/null 2>&1; then
    gum input --placeholder "https://example.com" --value "$preset" --prompt "HTTPS URL > "
  else
    local prompt="Enter HTTPS URL to check"
    if [ -n "$preset" ]; then
      prompt+=" [$preset]"
    fi
    prompt+=": "
    read -r -p "$prompt" input
    if [ -z "$input" ]; then
      input="$preset"
    fi
    echo "$input"
  fi
}

url="${1:-}"

if [ -z "$url" ]; then
  url="$(prompt_for_url "$default_url")"
fi

if [ -z "$url" ]; then
  echo "[https-check] No URL provided; aborting." >&2
  exit 1
fi

if [[ "$url" != https://* ]]; then
  echo "[https-check] URL must start with https:// (got: $url)" >&2
  exit 1
fi

echo "[https-check] Checking $url ..."
set +e
http_code="$(curl -sS -o /dev/null -w "%{http_code}" --location --max-time 15 --connect-timeout 5 "$url")"
curl_status=$?
set -e

if [ "$curl_status" -ne 0 ]; then
  echo "[https-check] Connection or TLS handshake failed (curl exit $curl_status)." >&2
  exit 1
fi

if [[ "$http_code" =~ ^[0-9]{3}$ ]] && [ "$http_code" -ge 200 ] && [ "$http_code" -lt 400 ]; then
  echo "[https-check] Success: received HTTP $http_code over HTTPS."
  exit 0
fi

echo "[https-check] HTTPS responded with HTTP $http_code (expected 2xx/3xx)." >&2
exit 1
