#!/usr/bin/env bash

# Install a systemd user service + timer for daily agent_auth_events retention.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "[auth-events-prune-timer] systemctl not found. systemd timers are not supported on this host." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

SERVICE_FILE="$UNIT_DIR/agent-auth-events-prune.service"
TIMER_FILE="$UNIT_DIR/agent-auth-events-prune.timer"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Prune old agent auth audit events

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
ExecStart=$NODE_BIN $ROOT_DIR/scripts/prune_auth_events.js
EOF

cat > "$TIMER_FILE" <<'EOF'
[Unit]
Description=Prune old agent auth audit events daily

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF

echo "[auth-events-prune-timer] Enabling systemd user timer..."
systemctl --user daemon-reload
systemctl --user enable --now agent-auth-events-prune.timer

echo "[auth-events-prune-timer] Timer installed."
echo "[auth-events-prune-timer] Check status with: systemctl --user status agent-auth-events-prune.timer"
echo "[auth-events-prune-timer] Logs: journalctl --user -u agent-auth-events-prune.service"
