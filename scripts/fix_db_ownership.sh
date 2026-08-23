#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

echo "[fix-db-owner] Database ownership repair tool"
echo "[fix-db-owner] This will ensure DB user can run migrations and alter tables."
echo ""

if [ ! -f ".env" ]; then
  echo "[fix-db-owner] ERROR: .env file not found." >&2
  exit 1
fi

get_env_value() {
  local key="$1"
  local line
  local value

  line="$(grep -E "^${key}=" .env | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"

  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:-1}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:-1}"
  fi

  printf '%s' "$value"
}

update_env() {
  local key="$1"
  local value="$2"
  local escaped
  escaped="$(printf '%s\n' "$value" | sed 's/[\\/&|]/\\&/g')"

  if grep -q "^$key=" .env; then
    sed -i "s|^$key=.*|$key=$escaped|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

DB_NAME="${DB_NAME:-$(get_env_value "DB_NAME")}"
DB_NAME="${DB_NAME:-agent_messaging_platform}"

APP_DB_USER="${DB_USER:-$(get_env_value "DB_USER")}"
if [ -z "$APP_DB_USER" ] || [ "$APP_DB_USER" = "postgres" ] || [ "$APP_DB_USER" = "onrm" ]; then
  APP_DB_USER="agent_app_user"
fi

APP_DB_PASSWORD="${DB_PASSWORD:-$(get_env_value "DB_PASSWORD")}"
if [ -z "$APP_DB_PASSWORD" ]; then
  APP_DB_PASSWORD="$(openssl rand -base64 24)"
fi

echo "[fix-db-owner] Checking PostgreSQL service..."
if ! sudo service postgresql status | grep -q "online\|active"; then
  echo "[fix-db-owner] PostgreSQL is not running. Starting it..."
  sudo service postgresql start
  sleep 2
fi

echo "[fix-db-owner] Ensuring database '$DB_NAME' exists..."
DB_EXISTS="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | tr -d ' ')"
if [ "$DB_EXISTS" != "1" ]; then
  echo "[fix-db-owner] Creating database '$DB_NAME'..."
  sudo -u postgres createdb "$DB_NAME"
fi

echo "[fix-db-owner] Ensuring role '$APP_DB_USER' exists..."
USER_EXISTS="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$APP_DB_USER'" 2>/dev/null | tr -d ' ')"
if [ "$USER_EXISTS" = "1" ]; then
  sudo -u postgres psql -c "ALTER USER \"$APP_DB_USER\" WITH PASSWORD '$APP_DB_PASSWORD';"
else
  sudo -u postgres psql -c "CREATE USER \"$APP_DB_USER\" WITH PASSWORD '$APP_DB_PASSWORD';"
fi

echo "[fix-db-owner] Setting database owner to '$APP_DB_USER'..."
sudo -u postgres psql -c "ALTER DATABASE \"$DB_NAME\" OWNER TO \"$APP_DB_USER\";"

echo "[fix-db-owner] Updating table ownership..."
while IFS= read -r table_name; do
  [ -z "$table_name" ] && continue
  sudo -u postgres psql -d "$DB_NAME" -c "ALTER TABLE public.\"$table_name\" OWNER TO \"$APP_DB_USER\";"
done < <(sudo -u postgres psql -d "$DB_NAME" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public';")

echo "[fix-db-owner] Updating sequence ownership..."
while IFS= read -r seq_name; do
  [ -z "$seq_name" ] && continue
  sudo -u postgres psql -d "$DB_NAME" -c "ALTER SEQUENCE public.\"$seq_name\" OWNER TO \"$APP_DB_USER\";"
done < <(sudo -u postgres psql -d "$DB_NAME" -Atc "SELECT sequencename FROM pg_sequences WHERE schemaname='public';")

echo "[fix-db-owner] Granting privileges..."
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$APP_DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO \"$APP_DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"$APP_DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"$APP_DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"$APP_DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO \"$APP_DB_USER\";"

echo "[fix-db-owner] Updating .env..."
update_env "DB_USER" "$APP_DB_USER"
update_env "DB_PASSWORD" "$APP_DB_PASSWORD"
update_env "DB_NAME" "$DB_NAME"
update_env "DB_HOST" "localhost"
update_env "DB_PORT" "5432"

echo "[fix-db-owner] Testing connection with updated credentials..."
export PGPASSWORD="$APP_DB_PASSWORD"
if psql -h localhost -p 5432 -U "$APP_DB_USER" -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
  echo "[fix-db-owner] ✓ Ownership and credentials repaired."
  echo "[fix-db-owner] You can now run 'start_fg' again."
else
  echo "[fix-db-owner] ✗ Connection test failed." >&2
  exit 1
fi
