#!/usr/bin/env bash

# Create a compressed PostgreSQL dump using env vars from .env

set -euo pipefail

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

echo "[backup-db] Creating backup for database '$DB_NAME' at $backup_file"

PGPASSWORD="$DB_PASSWORD" pg_dump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --format=plain \
  --no-owner \
  --no-privileges \
  "$DB_NAME" \
  | gzip > "$backup_file"

echo "[backup-db] Backup completed."
echo "[backup-db] To restore: gunzip -c \"$backup_file\" | PGPASSWORD=\$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME"

# Optional: prune backups older than 14 days
if command -v find >/dev/null 2>&1; then
  find "$BACKUP_DIR" -type f -name "${DB_NAME}_*.sql.gz" -mtime +14 -print -delete 2>/dev/null || true
fi
