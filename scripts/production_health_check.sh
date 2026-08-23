#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

ROOT_DIR="${HEALTH_ROOT_DIR:-$ROOT_DIR}"
ENV_FILE="$ROOT_DIR/.env"
SERVICE_NAME="${SERVICE_NAME:-agent-messaging-platform}"
DISK_USAGE_MAX_PERCENT="${DISK_USAGE_MAX_PERCENT:-95}"
RECENT_CRASH_WINDOW_SECONDS="${RECENT_CRASH_WINDOW_SECONDS:-900}"

load_env_if_present() {
  if [ ! -f "$ENV_FILE" ]; then
    return
  fi

  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    [ -z "$line" ] && continue
    [[ "$line" == \#* ]] && continue
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      export "$line"
    fi
  done < "$ENV_FILE"
}

strip_quotes() {
  local value="$1"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

http_ok() {
  local url="$1"
  local label="$2"

  if ! command -v curl >/dev/null 2>&1; then
    echo "[health] FAIL $label: curl is not installed" >&2
    return 1
  fi

  local http_code
  local curl_status
  set +e
  http_code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time "${HEALTH_CURL_MAX_TIME:-10}" --connect-timeout "${HEALTH_CURL_CONNECT_TIMEOUT:-3}" "$url")"
  curl_status=$?
  set -e

  if [ "$curl_status" -ne 0 ]; then
    echo "[health] FAIL $label: curl exit $curl_status for $url" >&2
    return 1
  fi

  if [[ "$http_code" =~ ^[0-9]{3}$ ]] && [ "$http_code" -ge 200 ] && [ "$http_code" -lt 400 ]; then
    echo "[health] OK $label: HTTP $http_code"
    return 0
  fi

  echo "[health] FAIL $label: HTTP $http_code for $url" >&2
  return 1
}

check_systemd_service() {
  local mode="${REQUIRE_SYSTEMD_SERVICE:-auto}"

  if [ "$mode" = "false" ] || [ "$mode" = "0" ]; then
    echo "[health] SKIP systemd service check"
    return 0
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    if [ "$mode" = "auto" ]; then
      echo "[health] SKIP systemd service check: systemctl unavailable"
      return 0
    fi
    echo "[health] FAIL systemd service: systemctl unavailable" >&2
    return 1
  fi

  if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    echo "[health] OK systemd service: ${SERVICE_NAME}.service active"
    return 0
  fi

  echo "[health] FAIL systemd service: ${SERVICE_NAME}.service is not active" >&2
  return 1
}

check_disk_usage() {
  if ! command -v df >/dev/null 2>&1; then
    echo "[health] SKIP disk usage check: df unavailable"
    return 0
  fi

  local usage
  usage="$(df -P "$ROOT_DIR" 2>/dev/null | awk 'NR==2 {gsub("%", "", $5); print $5}')"
  if ! [[ "$usage" =~ ^[0-9]+$ ]]; then
    echo "[health] FAIL disk usage: could not parse df output" >&2
    return 1
  fi

  if [ "$usage" -ge "$DISK_USAGE_MAX_PERCENT" ]; then
    echo "[health] FAIL disk usage: ${usage}% used, threshold is ${DISK_USAGE_MAX_PERCENT}%" >&2
    return 1
  fi

  echo "[health] OK disk usage: ${usage}% used"
  return 0
}

check_recent_crash_marker() {
  local alert_file="${CRASH_ALERT_FILE:-$ROOT_DIR/tmp/last_server_crash_alert.txt}"

  if [ ! -s "$alert_file" ]; then
    echo "[health] OK crash marker: none"
    return 0
  fi

  local now
  local mtime
  now="$(date +%s)"
  if stat -c %Y "$alert_file" >/dev/null 2>&1; then
    mtime="$(stat -c %Y "$alert_file")"
  else
    mtime="$(stat -f %m "$alert_file" 2>/dev/null || echo 0)"
  fi

  if ! [[ "$mtime" =~ ^[0-9]+$ ]]; then
    echo "[health] FAIL crash marker: could not read timestamp for $alert_file" >&2
    return 1
  fi

  if [ $((now - mtime)) -le "$RECENT_CRASH_WINDOW_SECONDS" ]; then
    echo "[health] FAIL crash marker: recent supervisor alert in $alert_file" >&2
    return 1
  fi

  echo "[health] OK crash marker: no recent alert"
  return 0
}

check_backup_service() {
  local mode="${REQUIRE_BACKUP_HEALTH:-auto}"
  local backup_service="${BACKUP_SERVICE_NAME:-agent-backup}"

  if [ "$mode" = "false" ] || [ "$mode" = "0" ]; then
    echo "[health] SKIP database backup check"
    return 0
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    if [ "$mode" = "auto" ]; then
      echo "[health] SKIP database backup check: systemctl unavailable"
      return 0
    fi
    echo "[health] FAIL database backup: systemctl unavailable" >&2
    return 1
  fi

  # A oneshot backup service is normally inactive after success. `is-failed`
  # distinguishes that healthy inactive state from its last run failing.
  if systemctl --user is-failed --quiet "${backup_service}.service"; then
    echo "[health] FAIL database backup: ${backup_service}.service last run failed" >&2
    return 1
  fi

  echo "[health] OK database backup: ${backup_service}.service has no failed run"
  return 0
}

load_env_if_present

APP_PORT="${PORT:-3000}"
APP_HEALTH_URL="${APP_HEALTH_URL:-http://127.0.0.1:${APP_PORT}/}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-${BASE_URL:-}}"
PUBLIC_HEALTH_URL="$(strip_quotes "$PUBLIC_HEALTH_URL")"
REQUIRE_PUBLIC_HEALTH="${REQUIRE_PUBLIC_HEALTH:-auto}"

failures=0

check_systemd_service || failures=$((failures + 1))
http_ok "$APP_HEALTH_URL" "app upstream" || failures=$((failures + 1))

if [ -n "$PUBLIC_HEALTH_URL" ]; then
  http_ok "$PUBLIC_HEALTH_URL" "public nginx endpoint" || failures=$((failures + 1))
elif [ "$REQUIRE_PUBLIC_HEALTH" = "true" ] || [ "$REQUIRE_PUBLIC_HEALTH" = "1" ]; then
  echo "[health] FAIL public nginx endpoint: PUBLIC_HEALTH_URL or BASE_URL is required" >&2
  failures=$((failures + 1))
else
  echo "[health] SKIP public nginx endpoint: no URL configured"
fi

check_recent_crash_marker || failures=$((failures + 1))
check_backup_service || failures=$((failures + 1))
check_disk_usage || failures=$((failures + 1))

if [ "$failures" -gt 0 ]; then
  echo "[health] FAIL production health check: $failures failed check(s)" >&2
  exit 1
fi

echo "[health] OK production health check"
