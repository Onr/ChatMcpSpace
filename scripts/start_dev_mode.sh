#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

# Mark that we're in dev mode (prevents _disable_dev_user.sh from running)
export DEV_MODE_ACTIVE=true

# Development mode default credentials
DEV_EMAIL="123@gmail.com"
DEV_PASSWORD="12345678"

echo ""
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║                    ⚠️  SECURITY WARNING ⚠️                            ║"
echo "╠══════════════════════════════════════════════════════════════════════╣"
echo "║  You are starting the server in DEVELOPMENT MODE                     ║"
echo "║                                                                      ║"
echo "║  A default test user will be created/available:                      ║"
echo "║    Email:    $DEV_EMAIL                                       ║"
echo "║    Password: $DEV_PASSWORD                                            ║"
echo "║                                                                      ║"
echo "║  ❌ DO NOT use this mode in production!                              ║"
echo "║  ❌ DO NOT expose this server to the internet!                       ║"
echo "║  ❌ This is for LOCAL TESTING ONLY!                                  ║"
echo "║                                                                      ║"
echo "║  Anyone with access to this server can log in with these             ║"
echo "║  credentials and access all data for this test user.                 ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""

# Check environment configuration
echo "[dev-mode] Checking environment configuration..."
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "[dev-mode] Created .env from template."
  else
    echo "[dev-mode] WARNING: .env.example missing; create .env manually." >&2
  fi
else
  echo "[dev-mode] .env already exists."
fi

# Ensure Node.js dependencies
echo "[dev-mode] Ensuring Node.js dependencies..."
if [ -d "node_modules" ]; then
  echo "[dev-mode] Dependencies already installed."
else
  npm install
fi

# Ensure PostgreSQL is running
echo "[dev-mode] Checking if PostgreSQL is running..."
if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  echo "[dev-mode] PostgreSQL is not running. Starting it now..."
  if sudo service postgresql start; then
    echo "[dev-mode] PostgreSQL started successfully."
    sleep 2
  else
    echo "[dev-mode] ✗ Failed to start PostgreSQL!" >&2
    echo "[dev-mode] Please start PostgreSQL manually: sudo service postgresql start" >&2
    exit 1
  fi
else
  echo "[dev-mode] PostgreSQL is already running."
fi

# Ensure Redis is running
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
echo "[dev-mode] Checking if Redis is running on ${REDIS_HOST}:${REDIS_PORT}..."
if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  echo "[dev-mode] Redis is already running."
else
  echo "[dev-mode] Redis is not running. Starting it now..."
  if redis-server --bind "$REDIS_HOST" --port "$REDIS_PORT" --daemonize yes --save "" --appendonly no; then
    sleep 1
    if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
      echo "[dev-mode] Redis started successfully."
    else
      echo "[dev-mode] ⚠ Redis may not have started correctly. Continuing anyway..." >&2
    fi
  else
    echo "[dev-mode] ⚠ Failed to start Redis. The app may still work without it." >&2
  fi
fi

# Verify database connection
echo "[dev-mode] Verifying database connection..."
SCRIPTS_DIR="$(dirname "${BASH_SOURCE[0]}")"
if "$SCRIPTS_DIR/verify_db.sh"; then
  echo "[dev-mode] Database connection verified."
else
  echo "[dev-mode] ✗ Database connection failed!" >&2
  echo "[dev-mode] To fix this issue, you have two options:" >&2
  echo "[dev-mode]   1. Run 'fix_db' from the main CLI menu (quick fix)" >&2
  echo "[dev-mode]   2. Run 'db' from the main CLI menu (full setup)" >&2
  exit 1
fi

# Create or update the default dev user
echo "[dev-mode] Setting up default development user..."

# Create the dev user using Node.js
node -e "
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'agent_messaging_platform',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || ''
});

async function setupDevUser() {
  const email = '$DEV_EMAIL';
  const password = '$DEV_PASSWORD';

  try {
    // Check if email_verified column exists
    const colCheck = await pool.query(\`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'email_verified'
    \`);
    const hasEmailVerified = colCheck.rows.length > 0;

    if (!hasEmailVerified) {
      console.log('[dev-mode] ⚠️  email_verified column missing. Running migration...');
      // Try to add the column (will fail if not owner, but that's ok)
      try {
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP DEFAULT NULL');
        console.log('[dev-mode] Migration applied successfully.');
      } catch (migErr) {
        console.error('[dev-mode] ✗ Cannot add email_verified column. Run this as database owner:');
        console.error('    psql -U postgres -d agent_messaging_platform -c \"ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE;\"');
        process.exit(1);
      }
    }

    // Check if user already exists
    const existing = await pool.query('SELECT user_id FROM users WHERE email = \$1', [email]);

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      // Update password and ensure email is verified
      const passwordHash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash = \$1, email_verified = TRUE WHERE user_id = \$2', [passwordHash, user.user_id]);
      console.log('[dev-mode] Dev user already exists. Password reset to default.');
    } else {
      // Create new user with email_verified = TRUE
      const passwordHash = await bcrypt.hash(password, 10);
      const apiKey = crypto.randomUUID();
      const encryptionSalt = crypto.randomBytes(16).toString('base64');

      await pool.query(
        \`INSERT INTO users (email, password_hash, api_key, encryption_salt, email_verified, email_verified_at)
         VALUES (\$1, \$2, \$3, \$4, TRUE, NOW())\`,
        [email, passwordHash, apiKey, encryptionSalt]
      );
      console.log('[dev-mode] Dev user created successfully.');
    }
  } catch (error) {
    console.error('[dev-mode] Error setting up dev user:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

setupDevUser();
"

echo ""
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║  Development user ready!                                             ║"
echo "║  You can now log in with:                                            ║"
echo "║    Email:    $DEV_EMAIL                                       ║"
echo "║    Password: $DEV_PASSWORD                                            ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""

echo "[dev-mode] Launching npm start (foreground). Press Ctrl+C to stop."
npm start
