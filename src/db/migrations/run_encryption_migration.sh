#!/usr/bin/env bash
# Apply encryption column migration

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Load environment
if [ -f "$PROJECT_ROOT/.env" ]; then
    # shellcheck disable=SC2046
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
fi

DB_NAME="${DB_NAME:-agent_messaging}"
DB_USER="${DB_USER:-postgres}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

echo "==================================="
echo "Running Encryption Migration"
echo "==================================="
echo ""

if [ "$DB_USER" = "postgres" ] && [ -z "${DB_PASSWORD:-}" ]; then
    psql -U "$DB_USER" -d "$DB_NAME" -f "$SCRIPT_DIR/005_add_encryption_support.sql"
elif [ -n "${DB_PASSWORD:-}" ]; then
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$SCRIPT_DIR/005_add_encryption_support.sql"
else
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$SCRIPT_DIR/005_add_encryption_support.sql"
fi

echo ""
echo "✓ Migration completed successfully!"
echo ""
echo "Note: Existing messages have encrypted=false by default."
echo "Future messages will have the encrypted flag set correctly."
