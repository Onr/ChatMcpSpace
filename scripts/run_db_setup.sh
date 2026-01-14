#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

echo "[run-db-setup] Starting PostgreSQL service (requires sudo)..."
sudo service postgresql start
sleep 2

if sudo service postgresql status | grep -q "online\\|active"; then
  echo "[run-db-setup] PostgreSQL is running."
else
  echo "[run-db-setup] Failed to start PostgreSQL." >&2
  exit 1
fi

echo "[run-db-setup] Loading environment variables..."
if [ -f ".env" ]; then
  export $(grep -v '^#' .env | sed 's/#.*//' | xargs)
else
  echo "[run-db-setup] WARNING: .env file not found. Using defaults."
fi
ensure_env_file() {
  if [ -f ".env" ]; then
    return
  fi
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "[run-db-setup] Created .env from template."
  else
    touch .env
    echo "[run-db-setup] Created empty .env (no template found)."
  fi
}

escape_sed() {
  printf '%s\n' "$1" | sed 's/[\\/&|]/\\&/g'
}

update_env() {
  local key="$1"
  local value="$2"
  if grep -q "^$key=" .env; then
    local escaped
    escaped="$(escape_sed "$value")"
    sed -i "s|^$key=.*|$key=$escaped|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

ensure_env_file

DB_NAME=${DB_NAME:-agent_messaging_platform}
DB_USER=${DB_USER:-}
DB_PASSWORD=${DB_PASSWORD:-}

if [ -z "$DB_USER" ] || [ "$DB_USER" = "your_db_user" ]; then
  DB_USER="agent_app_user"
  echo "[run-db-setup] Using default DB user: $DB_USER"
fi

if [ "$DB_PASSWORD" = "your_db_password" ] || [ -z "$DB_PASSWORD" ]; then
  DB_PASSWORD="$(openssl rand -base64 24)"
  echo "[run-db-setup] Generated password for $DB_USER"
fi

echo "[run-db-setup] Checking database existence..."
DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null || echo "0")

if [ "$DB_EXISTS" = "1" ]; then
  echo "[run-db-setup] Database '$DB_NAME' already exists."
else
  echo "[run-db-setup] Creating database '$DB_NAME'..."
  sudo -u postgres createdb "$DB_NAME"
fi

# Create user if it doesn't exist and set password
if [ "$DB_USER" != "postgres" ]; then
  echo "[run-db-setup] Configuring user '$DB_USER'..."
  USER_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" 2>/dev/null || echo "0")
  
  if [ "$USER_EXISTS" = "0" ]; then
    echo "[run-db-setup] Creating user '$DB_USER'..."
    sudo -u postgres psql -c "CREATE USER \"$DB_USER\" WITH PASSWORD '$DB_PASSWORD';"
  else
    echo "[run-db-setup] User '$DB_USER' exists. Updating password..."
    sudo -u postgres psql -c "ALTER USER \"$DB_USER\" WITH PASSWORD '$DB_PASSWORD';"
  fi
  
  echo "[run-db-setup] Granting privileges..."
  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$DB_USER\";"
  # Also grant schema privileges if needed, usually public schema
  sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO \"$DB_USER\";"
  
  # Update .env file with actual credentials
  echo "[run-db-setup] Updating .env with database credentials..."
  update_env "DB_USER" "$DB_USER"
  update_env "DB_PASSWORD" "$DB_PASSWORD"
  update_env "DB_NAME" "$DB_NAME"
else
  # Using postgres user, update .env accordingly
  echo "[run-db-setup] Updating .env to use 'postgres' user..."
  update_env "DB_USER" "postgres"
  update_env "DB_PASSWORD" ""
  update_env "DB_NAME" "$DB_NAME"
fi

echo "[run-db-setup] Applying schema from src/db/schema.sql..."
if [ -f "src/db/schema.sql" ]; then
  # Use the configured user if possible, but for schema setup we might need superuser if the user was just created
  # However, usually it's safer to run schema setup as postgres (superuser) to avoid permission issues during table creation
  sudo -u postgres psql -d "$DB_NAME" -f src/db/schema.sql 2>&1 | grep -v "NOTICE\\|already exists" || true
  
  # Ensure the user has access to the created tables
  if [ "$DB_USER" != "postgres" ]; then
     sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"$DB_USER\";"
     sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"$DB_USER\";"
  fi
  
  echo "[run-db-setup] Schema applied."
else
  echo "[run-db-setup] WARNING: src/db/schema.sql not found." >&2
fi

echo "[run-db-setup] Database setup complete."
