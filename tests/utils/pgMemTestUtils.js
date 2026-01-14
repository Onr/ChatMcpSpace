const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');
const { v4: uuidv4 } = require('uuid');

const schemaPath = path.join(__dirname, '../../src/db/schema.sql');

function loadSchema(db) {
  const raw = fs.readFileSync(schemaPath, 'utf8').replace(/```/g, '');
  db.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid', implementation: uuidv4, impure: true });
  db.public.registerFunction({ name: 'now', returns: 'timestamp', implementation: () => new Date(), impure: true });
  db.public.none(raw);
}

function createTestDatabase() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  loadSchema(db);
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  const query = (text, params) => pool.query(text, params);
  return { db, pool, query };
}

async function applyRuntimeUserColumns(query) {
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT TRUE');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP');
}

async function applyEmailVerificationSchema(query) {
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP');

  await query(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      token VARCHAR(64) UNIQUE NOT NULL,
      token_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS email_logs (
      log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
      email_to VARCHAR(255) NOT NULL,
      email_from VARCHAR(255) NOT NULL,
      subject VARCHAR(500) NOT NULL,
      email_type VARCHAR(50) NOT NULL,
      status VARCHAR(20) NOT NULL,
      message_id VARCHAR(255),
      error_message TEXT,
      metadata TEXT DEFAULT '{}',
      sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function seedUser(query, overrides = {}) {
  const userId = overrides.userId || uuidv4();
  const email = overrides.email || 'test@example.com';
  const apiKey = overrides.apiKey || 'api-key';
  const encryptionSalt = overrides.encryptionSalt || 'salt';
  const passwordHash = overrides.passwordHash || 'hash';
  const emailVerified = overrides.emailVerified ?? true;

  await query(
    'INSERT INTO users (user_id, email, password_hash, api_key, encryption_salt, email_verified) VALUES ($1, $2, $3, $4, $5, $6)',
    [userId, email, passwordHash, apiKey, encryptionSalt, emailVerified]
  );

  return { userId, email, apiKey };
}

module.exports = {
  createTestDatabase,
  applyRuntimeUserColumns,
  applyEmailVerificationSchema,
  seedUser,
};
