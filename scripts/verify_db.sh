#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

# Load environment variables
if [ -f ".env" ]; then
  export $(grep -v '^#' .env | sed 's/#.*//' | xargs)
else
  echo "[verify-db] ERROR: .env file not found." >&2
  exit 1
fi

DB_USER=${DB_USER:-postgres}
DB_PASSWORD=${DB_PASSWORD:-}
DB_NAME=${DB_NAME:-agent_messaging_platform}
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}

# Check for placeholder credentials
if [ "$DB_USER" = "your_db_user" ] || [ "$DB_PASSWORD" = "your_db_password" ]; then
  echo "[verify-db] ERROR: .env contains placeholder credentials." >&2
  echo "[verify-db] Found: DB_USER='$DB_USER', DB_PASSWORD='$DB_PASSWORD'" >&2
  echo "[verify-db] Please run database setup or fix_db to configure proper credentials." >&2
  exit 1
fi

# Test database connection
echo "[verify-db] Testing connection to PostgreSQL..."
echo "[verify-db] Host: $DB_HOST:$DB_PORT"
echo "[verify-db] Database: $DB_NAME"
echo "[verify-db] User: $DB_USER"

# Try to connect - use sudo for postgres user (peer authentication)
# Try to connect
if [ -n "$DB_PASSWORD" ]; then
  export PGPASSWORD="$DB_PASSWORD"
fi

if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
  echo "[verify-db] ✓ Database connection successful!"
  exit 0
fi

echo "[verify-db] ✗ Database connection failed!" >&2
echo "[verify-db] Possible issues:" >&2
echo "[verify-db]   1. PostgreSQL is not running (try: sudo service postgresql start)" >&2
echo "[verify-db]   2. Database '$DB_NAME' does not exist" >&2
echo "[verify-db]   3. User '$DB_USER' does not exist or password is incorrect" >&2
echo "[verify-db]   4. User '$DB_USER' does not have access to database '$DB_NAME'" >&2
echo "[verify-db] Run 'db' option from main menu to set up the database." >&2
exit 1
