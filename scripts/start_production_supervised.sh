#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

SERVICE_NAME="agent-messaging-platform"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
RUNNER="$ROOT_DIR/scripts/run_production_supervised.sh"

get_env_value() {
  local key="$1"
  if [ -f ".env" ]; then
    grep -E "^${key}=" .env | tail -n1 | cut -d= -f2-
  fi
}

if ! command -v systemctl >/dev/null 2>&1; then
  echo "[start-production-supervised] systemctl not found; cannot install a persistent service." >&2
  echo "[start-production-supervised] You can still run: $RUNNER" >&2
  exit 1
fi

if [ ! -x "$RUNNER" ]; then
  echo "[start-production-supervised] Missing supervisor runner: $RUNNER" >&2
  exit 1
fi

echo "[start-production-supervised] Stopping any existing background server..."
"$ROOT_DIR/scripts/stop_server.sh" >/dev/null 2>&1 || true

echo "[start-production-supervised] Installing systemd service: $UNIT_PATH"

port="$(get_env_value PORT)"
https_port="$(get_env_value HTTPS_PORT)"
https_enabled="$(get_env_value HTTPS_ENABLED | tr '[:upper:]' '[:lower:]')"
https_key_path="$(get_env_value HTTPS_KEY_PATH)"
https_cert_path="$(get_env_value HTTPS_CERT_PATH)"

target_port="$port"
if [ "$https_enabled" = "true" ] && [ -n "$https_port" ]; then
  target_port="$https_port"
fi
if [ -z "$target_port" ]; then
  target_port="3000"
fi

service_user="$USER"
needs_root="false"

if [ "$target_port" -lt 1024 ]; then
  needs_root="true"
fi
if [ "$https_enabled" = "true" ]; then
  if [ -n "$https_key_path" ] && [ ! -r "$https_key_path" ]; then
    needs_root="true"
  fi
  if [ -n "$https_cert_path" ] && [ ! -r "$https_cert_path" ]; then
    needs_root="true"
  fi
fi

if [ "$needs_root" = "true" ]; then
  service_user="root"
fi

capability_block=""
if [ "$service_user" != "root" ]; then
  capability_block=$'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE'
fi

sudo mkdir -p /etc/systemd/system
sudo touch "$UNIT_PATH"
sudo chown root:root "$UNIT_PATH"
sudo chmod 0644 "$UNIT_PATH"

# Ensure log files exist and are writable by the app user
sudo touch "$ROOT_DIR/server.log" "$ROOT_DIR/server_supervisor.log" "$ROOT_DIR/server_crash.log"
sudo chown "$USER":"$USER" "$ROOT_DIR/server.log" "$ROOT_DIR/server_supervisor.log" "$ROOT_DIR/server_crash.log"
mkdir -p "$ROOT_DIR/tmp"

if [ -d /etc/logrotate.d ]; then
  LOGROTATE_PATH="/etc/logrotate.d/${SERVICE_NAME}"
  # Older installers used these names for the same server.log. Leave unrelated
  # logrotate rules alone, but remove an exact duplicate before installing the
  # single canonical rule below.
  for legacy_path in /etc/logrotate.d/agents-mcpspace /etc/logrotate.d/agentsmcpspace; do
    if [ -f "$legacy_path" ] && grep -Fq "$ROOT_DIR/server.log" "$legacy_path"; then
      sudo rm -f "$legacy_path"
      echo "[start-production-supervised] Removed duplicate logrotate config: $legacy_path"
    fi
  done
  sudo bash -c "cat > \"$LOGROTATE_PATH\" <<EOF
$ROOT_DIR/server.log $ROOT_DIR/server_supervisor.log $ROOT_DIR/server_crash.log {
  daily
  maxsize 25M
  rotate 7
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  su $USER $USER
}
EOF"
  sudo chmod 0644 "$LOGROTATE_PATH"
  echo "[start-production-supervised] Installed logrotate config: $LOGROTATE_PATH"
else
  echo "[start-production-supervised] /etc/logrotate.d not found; skipping logrotate config"
fi

sudo bash -c "cat > \"$UNIT_PATH\" <<EOF
[Unit]
Description=Agent Messaging Platform (production, supervised)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$service_user
WorkingDirectory=$ROOT_DIR
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=NODE_ENV=production
Environment=MAX_RESTARTS=5
Environment=RESTART_WINDOW_SECONDS=600
ExecStart=$RUNNER
Restart=on-failure
RestartSec=2
StartLimitIntervalSec=600
StartLimitBurst=5
$capability_block
NoNewPrivileges=true
StandardOutput=append:$ROOT_DIR/server.log
StandardError=append:$ROOT_DIR/server.log

[Install]
WantedBy=multi-user.target
EOF"

echo "[start-production-supervised] Enabling and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}.service"

echo "[start-production-supervised] Service status:"
sudo systemctl --no-pager --full status "${SERVICE_NAME}.service" || true

echo "[start-production-supervised] Logs:"
echo "  - App: $ROOT_DIR/server.log"
echo "  - Supervisor: $ROOT_DIR/server_supervisor.log"
echo "  - Crash alerts: $ROOT_DIR/server_crash.log (latest: $ROOT_DIR/tmp/last_server_crash_alert.txt)"
