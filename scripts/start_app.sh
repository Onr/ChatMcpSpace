#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"
ensure_supported_node 16

# --local runs the server in local mode: register and sign in with just an email
# and a password, no verification email and no Google OAuth needed.
LOCAL_MODE_REQUESTED=false
for arg in "$@"; do
  case "$arg" in
    --local|--local-mode)
      LOCAL_MODE_REQUESTED=true
      ;;
    -h|--help)
      echo "Usage: ${BASH_SOURCE[0]##*/} [--local]"
      echo "  --local   Start in local mode (self-registration without a verification email)."
      exit 0
      ;;
    *)
      echo "[start-app] Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

echo "[start-app] Checking environment configuration..."
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "[start-app] Created .env from template."
    # The template ships a placeholder secret; give this install its own so
    # sessions are not signed with a value that is public on GitHub.
    if grep -q '^SESSION_SECRET=your_session_secret_key_here$' .env; then
      generated_secret="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
      tmp_env="$(mktemp)"
      SESSION_SECRET_VALUE="$generated_secret" node -e '
        const fs = require("fs");
        const env = fs.readFileSync(".env", "utf8");
        fs.writeFileSync(process.argv[1], env.replace(
          /^SESSION_SECRET=your_session_secret_key_here$/m,
          "SESSION_SECRET=" + process.env.SESSION_SECRET_VALUE
        ));
      ' "$tmp_env"
      mv "$tmp_env" .env
      echo "[start-app] Generated a random SESSION_SECRET for this install."
    fi
  else
    echo "[start-app] WARNING: .env.example missing; create .env manually." >&2
  fi
else
  echo "[start-app] .env already exists."
fi

if [ "$LOCAL_MODE_REQUESTED" = "true" ]; then
  export LOCAL_MODE=true
  echo ""
  echo "[start-app] LOCAL MODE enabled."
  echo "[start-app]   Open the site, click Get Started, and register with any"
  echo "[start-app]   email + password. You are signed in immediately -- no"
  echo "[start-app]   verification email and no Google account required."
  echo "[start-app]   Do NOT use this on an internet-facing server."
  echo ""
fi

echo "[start-app] Ensuring Node.js dependencies..."
if [ -d "node_modules" ]; then
  echo "[start-app] Dependencies already installed."
else
  npm install
fi

# Ensure PostgreSQL is running
echo "[start-app] Checking if PostgreSQL is running..."
if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  echo "[start-app] PostgreSQL is not running. Starting it now..."
  if sudo service postgresql start; then
    echo "[start-app] PostgreSQL started successfully."
    sleep 2  # Give PostgreSQL a moment to fully start
  else
    echo "[start-app] ✗ Failed to start PostgreSQL!" >&2
    echo "[start-app] Please start PostgreSQL manually: sudo service postgresql start" >&2
    exit 1
  fi
else
  echo "[start-app] PostgreSQL is already running."
fi

# Ensure Redis is running
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
echo "[start-app] Checking if Redis is running on ${REDIS_HOST}:${REDIS_PORT}..."
if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  echo "[start-app] Redis is already running."
else
  echo "[start-app] Redis is not running. Starting it now..."
  if redis-server --bind "$REDIS_HOST" --port "$REDIS_PORT" --daemonize yes --save "" --appendonly no; then
    sleep 1
    if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
      echo "[start-app] Redis started successfully."
    else
      echo "[start-app] ⚠ Redis may not have started correctly. Continuing anyway..." >&2
    fi
  else
    echo "[start-app] ⚠ Failed to start Redis. The app may still work without it." >&2
  fi
fi

# Verify database connection before starting
echo "[start-app] Verifying database connection..."
SCRIPTS_DIR="$(dirname "${BASH_SOURCE[0]}")"
if "$SCRIPTS_DIR/verify_db.sh"; then
  echo "[start-app] Database connection verified."
else
  echo "[start-app] ✗ Database connection failed!" >&2
  echo "[start-app] To fix this issue, you have two options:" >&2
  echo "[start-app]   1. Run 'fix_db' from the main CLI menu (quick fix)" >&2
  echo "[start-app]   2. Run 'db' from the main CLI menu (full setup)" >&2
  exit 1
fi

# Security: Disable dev mode test user if not in dev mode
"$SCRIPTS_DIR/_disable_dev_user.sh"

echo "[start-app] Launching npm start (foreground). Press Ctrl+C to stop."
npm start
