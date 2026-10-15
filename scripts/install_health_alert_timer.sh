#!/usr/bin/env bash

# Install a systemd user service + timer for server health chat alerts.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "[health-alert-timer] systemctl not found. systemd timers are not supported on this host." >&2
  exit 1
fi

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

SERVICE_FILE="$UNIT_DIR/agent-health-alert.service"
TIMER_FILE="$UNIT_DIR/agent-health-alert.timer"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Agent server health alert

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=DISK_USAGE_MAX_PERCENT=90
Environment=HEALTH_ALERT_COOLDOWN_SECONDS=3600
Environment=HEALTH_ALERT_AUTO_REMEDIATE=true
Environment=HEALTH_ALERT_RECHECK_DELAY_SECONDS=3
Environment=HEALTH_ALERT_AGENT_DIR=$ROOT_DIR/.chatspace/agentsmcpspace
ExecStart=$ROOT_DIR/scripts/health_alert_notify.sh
EOF

cat > "$TIMER_FILE" <<'EOF'
[Unit]
Description=Run Agent server health alert monitor every 10 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
EOF

chmod +x "$ROOT_DIR/scripts/health_alert_notify.sh"
chmod +x "$ROOT_DIR/scripts/disk_pressure_cleanup.sh"

echo "[health-alert-timer] Enabling systemd user timer..."
systemctl --user daemon-reload
systemctl --user enable --now agent-health-alert.timer

echo "[health-alert-timer] Timer installed."
echo "[health-alert-timer] Check status with: systemctl --user status agent-health-alert.timer"
echo "[health-alert-timer] Logs: journalctl --user -u agent-health-alert.service"
