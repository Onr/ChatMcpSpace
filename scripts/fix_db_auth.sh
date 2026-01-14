#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

echo "[fix-db-auth] Database Authentication Repair Tool"
echo "[fix-db-auth] This will create a dedicated database user with a password."
echo ""

# Load environment variables
if [ -f ".env" ]; then
  export $(grep -v '^#' .env | xargs)
else
  echo "[fix-db-auth] ERROR: .env file not found." >&2
  exit 1
fi

DB_NAME=${DB_NAME:-agent_messaging_platform}
APP_DB_USER="agent_app_user"
APP_DB_PASSWORD=$(openssl rand -base64 24)

# Check if PostgreSQL is running
echo "[fix-db-auth] Checking PostgreSQL service..."
if ! sudo service postgresql status | grep -q "online\|active"; then
  echo "[fix-db-auth] PostgreSQL is not running. Starting it..."
  sudo service postgresql start
  sleep 2
fi

# Check if database exists
echo "[fix-db-auth] Checking if database '$DB_NAME' exists..."
DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null || echo "0")

if [ "$DB_EXISTS" = "0" ]; then
  echo "[fix-db-auth] Database '$DB_NAME' does not exist."
  echo "[fix-db-auth] Creating database..."
  sudo -u postgres createdb "$DB_NAME"
fi

# Create dedicated application user
echo "[fix-db-auth] Creating dedicated database user '$APP_DB_USER'..."
USER_EXISTS=$(sudo -u postgres psql -tAc "SELECT COUNT(*) FROM pg_roles WHERE rolname='$APP_DB_USER'" 2>/dev/null | tr -d ' ')

if [ "$USER_EXISTS" = "1" ]; then
  echo "[fix-db-auth] User '$APP_DB_USER' already exists. Updating password..."
  sudo -u postgres psql -c "ALTER USER \"$APP_DB_USER\" WITH PASSWORD '$APP_DB_PASSWORD';" 2>/dev/null || true
else
  echo "[fix-db-auth] Creating new user '$APP_DB_USER'..."
  sudo -u postgres psql -c "CREATE USER \"$APP_DB_USER\" WITH PASSWORD '$APP_DB_PASSWORD';" 2>/dev/null || {
    echo "[fix-db-auth] User creation failed, trying to update password instead..."
    sudo -u postgres psql -c "ALTER USER \"$APP_DB_USER\" WITH PASSWORD '$APP_DB_PASSWORD';"
  }
fi

# Grant privileges
echo "[fix-db-auth] Granting privileges..."
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$APP_DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO \"$APP_DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"$APP_DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"$APP_DB_USER\";"

# Apply schema if available and no tables exist
TABLE_COUNT=$(sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "0")
if [ "$TABLE_COUNT" = "0" ] && [ -f "src/db/schema.sql" ]; then
  echo "[fix-db-auth] Applying schema..."
  sudo -u postgres psql -d "$DB_NAME" -f src/db/schema.sql 2>&1 | grep -v "NOTICE\|already exists" || true
  # Re-grant privileges after schema creation
  sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"$APP_DB_USER\";"
  sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"$APP_DB_USER\";"
fi

# Update .env file
echo "[fix-db-auth] Updating .env with new credentials..."
# Escape special characters for sed
ESCAPED_PASSWORD=$(printf '%s\n' "$APP_DB_PASSWORD" | sed 's/[&/\]/\\&/g')
update_env() {
  local key="$1"
  local val="$2"
  if grep -q "^$key=" .env; then
    sed -i "s|^$key=.*|$key=$val|" .env
  else
    echo "$key=$val" >> .env
  fi
}

update_env "DB_USER" "$APP_DB_USER"
update_env "DB_PASSWORD" "$ESCAPED_PASSWORD"
update_env "DB_NAME" "$DB_NAME"
update_env "DB_HOST" "localhost"
update_env "DB_PORT" "5432"

# Test connection with new credentials
echo "[fix-db-auth] Testing connection with new credentials..."
export PGPASSWORD="$APP_DB_PASSWORD"
if psql -h localhost -p 5432 -U "$APP_DB_USER" -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
  echo "[fix-db-auth] ✓ Database connection successful!"
  echo "[fix-db-auth] Your .env file has been updated with new secure credentials."
  echo "[fix-db-auth] You can now run 'start_fg' to start the application."
  exit 0
else
  echo "[fix-db-auth] ✗ Connection test failed." >&2
  echo "[fix-db-auth] Please check the error messages above." >&2
  exit 1
fi
