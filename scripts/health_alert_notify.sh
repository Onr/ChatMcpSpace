#!/usr/bin/env bash

# Run production health checks and send chat alerts on failures/recovery.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

AGENT_DIR="${HEALTH_ALERT_AGENT_DIR:-$ROOT_DIR/.chatspace/agentsmcpspace}"
MESSAGE_HELPER="${HEALTH_ALERT_MESSAGE_HELPER:-$AGENT_DIR/message_helper.py}"
STATE_DIR="${HEALTH_ALERT_STATE_DIR:-$ROOT_DIR/tmp/health-monitor}"
STATUS_FILE="$STATE_DIR/status"
LAST_ALERT_FILE="$STATE_DIR/last-alert"
LAST_OUTPUT_FILE="$STATE_DIR/last-output.txt"
ALERT_COOLDOWN_SECONDS="${HEALTH_ALERT_COOLDOWN_SECONDS:-3600}"
DISK_USAGE_MAX_PERCENT="${DISK_USAGE_MAX_PERCENT:-90}"
REQUIRE_SYSTEMD_SERVICE="${REQUIRE_SYSTEMD_SERVICE:-true}"
REQUIRE_PUBLIC_HEALTH="${REQUIRE_PUBLIC_HEALTH:-auto}"
AUTO_REMEDIATE="${HEALTH_ALERT_AUTO_REMEDIATE:-true}"
SERVICE_NAME="${SERVICE_NAME:-agent-messaging-platform}"

mkdir -p "$STATE_DIR"

# Resolve disk-only alerts before evaluating overall production health.  The
# cleanup script is guarded by the same threshold and only removes disposable
# package/browser caches, so it is safe to invoke on every monitor run.
cleanup_output="$(
  DISK_CLEANUP_TRIGGER_PERCENT="$DISK_USAGE_MAX_PERCENT" \
  "$ROOT_DIR/scripts/disk_pressure_cleanup.sh" 2>&1
)" || cleanup_output="[disk-cleanup] failed; continuing with health check"

send_chat_message() {
  local priority="$1"
  local message="$2"

  if [ ! -f "$MESSAGE_HELPER" ]; then
    echo "[health-alert] message helper not found: $MESSAGE_HELPER" >&2
    return 1
  fi

  (cd "$AGENT_DIR" && uv run message_helper.py send "$message" --priority "$priority")
}

truncate_output() {
  awk 'length($0) > 500 { print substr($0, 1, 500) "..."; next } { print }' | tail -n 18
}

run_health_check() {
  DISK_USAGE_MAX_PERCENT="$DISK_USAGE_MAX_PERCENT" \
  REQUIRE_SYSTEMD_SERVICE="$REQUIRE_SYSTEMD_SERVICE" \
  REQUIRE_PUBLIC_HEALTH="$REQUIRE_PUBLIC_HEALTH" \
  "$ROOT_DIR/scripts/production_health_check.sh" 2>&1
}

can_remediate_service() {
  # Restart only when the supervised application or its local upstream failed.
  # Do not restart for a backup failure, disk pressure, crash marker, or an
  # isolated public-endpoint failure: those require diagnosis, not a blind
  # service bounce.
  [[ "$output" == *"FAIL systemd service:"* || "$output" == *"FAIL app upstream:"* ]]
}

restart_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "[health-remediation] skipped: systemctl is unavailable"
    return 1
  fi

  if systemctl restart "${SERVICE_NAME}.service" 2>&1; then
    echo "[health-remediation] restarted ${SERVICE_NAME}.service"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n systemctl restart "${SERVICE_NAME}.service" 2>&1; then
    echo "[health-remediation] restarted ${SERVICE_NAME}.service with sudo"
    return 0
  fi

  echo "[health-remediation] failed to restart ${SERVICE_NAME}.service" >&2
  return 1
}

now="$(date +%s)"
timestamp="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
output=""
status=0

set +e
output="$(
  run_health_check
)"
status=$?
set -e

remediation_output=""
if [ "$status" -ne 0 ] && [ "$AUTO_REMEDIATE" = "true" ] && can_remediate_service; then
  set +e
  remediation_output="$(restart_service 2>&1)"
  restart_status=$?
  if [ "$restart_status" -eq 0 ]; then
    sleep "${HEALTH_ALERT_RECHECK_DELAY_SECONDS:-3}"
    output="$(run_health_check)"
    status=$?
    remediation_output="$remediation_output
[health-remediation] health check rerun after restart"
  fi
  set -e
fi

if [ -n "$remediation_output" ]; then
  output="$remediation_output
$output"
fi

if [[ "$cleanup_output" != *"skipped:"* ]]; then
  output="$cleanup_output
$output"
fi

printf '%s\n' "$output" > "$LAST_OUTPUT_FILE"

previous_status="unknown"
if [ -s "$STATUS_FILE" ]; then
  previous_status="$(cat "$STATUS_FILE" 2>/dev/null || echo unknown)"
fi

if [ "$status" -eq 0 ]; then
  echo "ok" > "$STATUS_FILE"
  if [ -n "$remediation_output" ]; then
    send_chat_message 1 "**Server health automatically recovered**
**Time:** $timestamp
**Action:** restarted ${SERVICE_NAME}.service once, then re-ran the production health check.

$(printf '%s\n' "$output" | truncate_output)" || true
  elif [ "$previous_status" = "fail" ]; then
    send_chat_message 0 "**Server health recovered**
**Time:** $timestamp
**Status:** production health check is passing again.

$(printf '%s\n' "$output" | truncate_output)" || true
  fi
  exit 0
fi

last_alert=0
if [ -s "$LAST_ALERT_FILE" ]; then
  last_alert="$(cat "$LAST_ALERT_FILE" 2>/dev/null || echo 0)"
fi

if ! [[ "$last_alert" =~ ^[0-9]+$ ]]; then
  last_alert=0
fi

if [ "$previous_status" = "fail" ] && [ $((now - last_alert)) -lt "$ALERT_COOLDOWN_SECONDS" ]; then
  echo "fail" > "$STATUS_FILE"
  echo "[health-alert] health check failed; alert suppressed by cooldown"
  exit 0
fi

echo "$now" > "$LAST_ALERT_FILE"
echo "fail" > "$STATUS_FILE"

send_chat_message 2 "**Server health alert**
**Time:** $timestamp
**Trigger:** production health monitor
**Threshold:** disk usage >= ${DISK_USAGE_MAX_PERCENT}% or any production health failure
**Reported:**
$(printf '%s\n' "$output" | truncate_output)

**Recommended next step:** check disk usage, service status, and recent logs on the server." || true
