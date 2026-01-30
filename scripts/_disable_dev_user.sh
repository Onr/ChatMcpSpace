#!/usr/bin/env bash
# Helper script to disable the dev mode test user
# Called by start_app.sh, start_server.sh, and start_production.sh
# to ensure the insecure test user cannot be used outside of dev mode

set -euo pipefail

DEV_USER_EMAIL="123@gmail.com"

# Skip if DEV_MODE_ACTIVE is set (start_dev_mode.sh sets this)
if [ "${DEV_MODE_ACTIVE:-}" = "true" ]; then
  exit 0
fi

# Silently try to disable the dev user by randomizing its password
node -e "
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'agent_messaging_platform',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || ''
});

async function disableDevUser() {
  const devEmail = '$DEV_USER_EMAIL';
  try {
    const result = await pool.query('SELECT user_id FROM users WHERE email = \$1', [devEmail]);
    if (result.rows.length > 0) {
      const crypto = require('crypto');
      const randomPassword = crypto.randomBytes(32).toString('hex');
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash(randomPassword, 10);

      // Disable by setting password to random value (works without email_verified column)
      await pool.query(
        'UPDATE users SET password_hash = \$1 WHERE email = \$2',
        [hash, devEmail]
      );
      console.log('[security] Dev test user (${DEV_USER_EMAIL}) disabled.');
    }
  } catch (error) {
    // Silently fail - DB might not be ready yet
  } finally {
    await pool.end();
  }
}

disableDevUser();
" 2>/dev/null || true
