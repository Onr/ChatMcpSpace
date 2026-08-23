#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

SERVICE_LOG="$ROOT_DIR/server_supervisor.log"
CRASH_LOG="$ROOT_DIR/server_crash.log"
ALERT_FILE="$ROOT_DIR/tmp/last_server_crash_alert.txt"

MAX_RESTARTS="${MAX_RESTARTS:-5}"
RESTART_WINDOW_SECONDS="${RESTART_WINDOW_SECONDS:-600}"
STATE_FILE="$ROOT_DIR/tmp/server_supervisor_state"

mkdir -p "$ROOT_DIR/tmp"
touch "$SERVICE_LOG" "$CRASH_LOG" "$ALERT_FILE"

log_line() {
  local msg="$1"
  printf '%s %s\n' "$(date -Is)" "$msg" | tee -a "$SERVICE_LOG"
}

warn_crash() {
  local msg="$1"
  printf '%s %s\n' "$(date -Is)" "$msg" | tee -a "$CRASH_LOG" >"$ALERT_FILE"
  if command -v logger >/dev/null 2>&1; then
    logger -t "agent-messaging-platform" -- "$msg" || true
  fi
}

# Ensure .env exists; prefer production template if available.
if [ ! -f ".env" ]; then
  if [ -f ".env.production.example" ]; then
    cp .env.production.example .env
    log_line "[supervisor] Created .env from .env.production.example"
  elif [ -f ".env.example" ]; then
    cp .env.example .env
    log_line "[supervisor] Created .env from .env.example (production template missing)"
  else
    log_line "[supervisor] No env template found; create .env manually."
  fi
fi

log_line "[supervisor] Ensuring Node.js dependencies..."
if [ -d "node_modules" ]; then
  log_line "[supervisor] Dependencies already installed."
else
  npm install
fi

log_line "[supervisor] Verifying database connection..."
SCRIPTS_DIR="$(dirname "${BASH_SOURCE[0]}")"
if "$SCRIPTS_DIR/verify_db.sh"; then
  log_line "[supervisor] Database connection verified."
else
  warn_crash "[supervisor] Database connection failed. Not starting server."
  exit 1
fi

failure_count=0
last_failure_epoch=0
if [ -f "$STATE_FILE" ]; then
  read -r failure_count last_failure_epoch <"$STATE_FILE" || true
fi
now_epoch="$(date +%s)"
if [ "$last_failure_epoch" -gt 0 ] && [ $((now_epoch - last_failure_epoch)) -gt "$RESTART_WINDOW_SECONDS" ]; then
  failure_count=0
fi

child_pid=""
stopping="false"

stop_child() {
  stopping="true"
  if [ -n "$child_pid" ] && ps -p "$child_pid" >/dev/null 2>&1; then
    log_line "[supervisor] Stopping child process (PID $child_pid)"
    kill -TERM "$child_pid" 2>/dev/null || true
    sleep 1
    if ps -p "$child_pid" >/dev/null 2>&1; then
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
  fi
}

trap stop_child INT TERM

log_line "[supervisor] Starting production server (NODE_ENV=production)..."
set +e
env NODE_ENV=production npm start &
child_pid="$!"
wait "$child_pid"
exit_code="$?"
set -e

if [ "$stopping" = "true" ]; then
  log_line "[supervisor] Server stopped by signal (exit $exit_code)."
  exit 0
fi

# systemd can signal the npm child directly during a service restart, before
# this wrapper's TERM trap runs. Exit 143 is that normal SIGTERM shutdown, not
# an application crash, and must not create a health-check crash marker.
if [ "$exit_code" -eq 143 ]; then
  log_line "[supervisor] Server stopped by SIGTERM (exit 143)."
  exit 0
fi

if [ "$exit_code" -eq 0 ]; then
  warn_crash "[supervisor] Server exited cleanly but unexpectedly. Restarting through systemd."
  exit 1
fi

failure_count=$((failure_count + 1))
now_epoch="$(date +%s)"
printf '%s %s\n' "$failure_count" "$now_epoch" >"$STATE_FILE"

warn_crash "[supervisor] Server crashed (exit $exit_code). Restart attempt $failure_count/$MAX_RESTARTS"

if [ "$failure_count" -ge "$MAX_RESTARTS" ]; then
  warn_crash "[supervisor] Giving up after $failure_count crashes within ${RESTART_WINDOW_SECONDS}s. Check $ROOT_DIR/server.log and $CRASH_LOG"
  exit 1
fi

exit 1
