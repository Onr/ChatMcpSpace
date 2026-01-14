#!/usr/bin/env bash

# Install a systemd user service + timer to run backup_db.sh daily.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "[backup-timer] systemctl not found. systemd timers are not supported on this host." >&2
  exit 1
fi

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

SERVICE_FILE="$UNIT_DIR/agent-backup.service"
TIMER_FILE="$UNIT_DIR/agent-backup.timer"
SERVICE_WORKDIR="$ROOT_DIR"
SERVICE_EXEC="$ROOT_DIR/scripts/backup_db.sh"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Agent DB backup

[Service]
Type=oneshot
WorkingDirectory=$SERVICE_WORKDIR
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin
ExecStart=$SERVICE_EXEC
EOF

cat > "$TIMER_FILE" <<'EOF'
[Unit]
Description=Daily Agent DB backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
EOF

echo "[backup-timer] Enabling systemd user timer..."
systemctl --user daemon-reload
systemctl --user enable --now agent-backup.timer

echo "[backup-timer] Timer installed. Check status with: systemctl --user status agent-backup.timer"
echo "[backup-timer] Logs: journalctl --user -u agent-backup.service"
