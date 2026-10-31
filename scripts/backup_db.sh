#!/usr/bin/env bash

# Create a compressed PostgreSQL dump using env vars from .env

set -euo pipefail
umask 077

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[backup-db] pg_dump not found. Please install PostgreSQL client tools." >&2
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "[backup-db] .env file not found; cannot load DB credentials." >&2
  exit 1
fi

# Load simple KEY=VALUE entries without evaluating .env as shell code. This keeps
# backups working when ordinary values contain spaces and avoids executing a
# malformed or untrusted value from the environment file.
load_env_file() {
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [ -z "$line" ] && continue
    [[ "$line" == \#* ]] && continue
    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      echo "[backup-db] Ignoring malformed .env line." >&2
      continue
    fi

    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    export "$key=$value"
  done < .env
}

load_env_file

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-agent_messaging_platform}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-}"

BACKUP_DIR="$ROOT_DIR/backups"
mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
backup_file="$BACKUP_DIR/${DB_NAME}_${timestamp}.sql.gz"
partial_file="$(mktemp "$BACKUP_DIR/.db-backup-XXXXXX")"
trap 'rm -f "$partial_file"' EXIT

echo "[backup-db] Creating backup for database '$DB_NAME' at $backup_file"

# agent_auth_events is a high-volume audit log with its own retention job
# (scripts/prune_auth_events.js); dump its schema but not its rows.
PGPASSWORD="$DB_PASSWORD" pg_dump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --format=plain \
  --no-owner \
  --no-privileges \
  --exclude-table-data=agent_auth_events \
  "$DB_NAME" \
  | gzip > "$partial_file"

gzip -t "$partial_file"
mv "$partial_file" "$backup_file"

# Keep 14 days locally unless this run's dump is also verified off-site, in
# which case a short local window is enough and saves disk space. A failed
# upload still prunes with the 14-day window, then fails the job.
local_retention_days=14
offsite_failed=0
if [ "${SUPABASE_BACKUP_ENABLED:-false}" = "true" ]; then
  if python3 "$ROOT_DIR/scripts/supabase_backup.py" upload "$backup_file"; then
    local_retention_days="${BACKUP_LOCAL_RETENTION_DAYS_WITH_OFFSITE:-3}"
    if [[ ! "$local_retention_days" =~ ^[0-9]+$ ]] || [ "$local_retention_days" -lt 1 ]; then
      echo "[backup-db] Invalid BACKUP_LOCAL_RETENTION_DAYS_WITH_OFFSITE; keeping 14 days." >&2
      local_retention_days=14
    fi
  else
    offsite_failed=1
    echo "[backup-db] Off-site upload failed; local backup kept, keeping 14 days locally." >&2
  fi
fi

if [ "$offsite_failed" -eq 0 ]; then
  echo "[backup-db] Backup completed."
fi
echo "[backup-db] To restore: gunzip -c \"$backup_file\" | PGPASSWORD=\$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME"

# Prune older local dumps; the dump just created is never old enough to match.
if command -v find >/dev/null 2>&1; then
  find "$BACKUP_DIR" -type f -name "${DB_NAME}_*.sql.gz" -mtime "+$local_retention_days" -print -delete 2>/dev/null || true
fi

if [ "$offsite_failed" -ne 0 ]; then
  exit 1
fi
