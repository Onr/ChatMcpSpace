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
  const query = (text, params = []) => {
    let sql = text;
    let values = Array.isArray(params) ? [...params] : params;

    if (Array.isArray(values)) {
      if (/INSERT INTO email_verification_tokens\s*\(/i.test(sql) && !/token_id/i.test(sql)) {
        const nextIndex = values.length + 1;
        sql = sql.replace(
          /INSERT INTO email_verification_tokens\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i,
          (_match, columns, placeholders) =>
            `INSERT INTO email_verification_tokens (${columns}, token_id, created_at) VALUES (${placeholders}, $${nextIndex}, $${nextIndex + 1})`
        );
        values.push(uuidv4(), new Date());
      }

      if (/INSERT INTO email_logs\s*\(/i.test(sql) && !/log_id/i.test(sql)) {
        const nextIndex = values.length + 1;
        sql = sql.replace(
          /INSERT INTO email_logs\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i,
          (_match, columns, placeholders) =>
            `INSERT INTO email_logs (${columns}, log_id, created_at) VALUES (${placeholders}, $${nextIndex}, $${nextIndex + 1})`
        );
        values.push(uuidv4(), new Date());
      }
    }

    return pool.query(sql, values);
  };
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
      token_id UUID,
      user_id UUID,
      token VARCHAR(64),
      token_hash VARCHAR(255),
      expires_at TIMESTAMP,
      used_at TIMESTAMP,
      created_at TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS email_logs (
      log_id UUID,
      user_id UUID,
      email_to VARCHAR(255),
      email_from VARCHAR(255),
      subject VARCHAR(500),
      email_type VARCHAR(50),
      status VARCHAR(20),
      message_id VARCHAR(255),
      error_message TEXT,
      metadata TEXT,
      sent_at TIMESTAMP,
      created_at TIMESTAMP
    )
  `);
}

async function applyArchiveSchema(query) {
  // Add hidden_from_agent to user_messages
  await query('ALTER TABLE user_messages ADD COLUMN IF NOT EXISTS hidden_from_agent BOOLEAN DEFAULT FALSE');
  // Add hidden_from_agent to messages (agent messages)
  await query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS hidden_from_agent BOOLEAN DEFAULT FALSE');
  // Inter-agent / lineage compatibility columns used by current routes
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS can_spawn BOOLEAN DEFAULT FALSE');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS inter_agent_mode VARCHAR(50) DEFAULT \'disabled\'');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_working BOOLEAN DEFAULT FALSE');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_working_heartbeat_at TIMESTAMP');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS reported_cli_version VARCHAR(32)');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS reported_cli_version_at TIMESTAMP');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_config JSONB DEFAULT \'{}\'');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS allowed_permissions JSONB DEFAULT \'{}\'');

  await query(`
    CREATE TABLE IF NOT EXISTS archived_agents (
      archived_agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL UNIQUE,
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      agent_name VARCHAR(255) NOT NULL,
      agent_type VARCHAR(20) NOT NULL,
      total_messages INTEGER NOT NULL DEFAULT 0,
      archive_reason TEXT,
      archived_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS archived_messages (
      archived_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id UUID,
      user_message_id UUID,
      agent_id UUID NOT NULL,
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      message_type VARCHAR(20) NOT NULL,
      content_snapshot TEXT,
      has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
      archive_note TEXT,
      archived_at TIMESTAMP DEFAULT NOW(),
      CHECK (
        (message_id IS NOT NULL AND user_message_id IS NULL) OR
        (message_id IS NULL AND user_message_id IS NOT NULL)
      )
    )
  `);

  // Inter-agent messaging table (migration 018)
  await query(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      agent_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sender_agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      recipient_agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      encrypted BOOLEAN DEFAULT FALSE,
      priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1, 2)),
      read_at TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT different_agents CHECK (sender_agent_id != recipient_agent_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scheduled_user_messages (
      scheduled_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      encrypted BOOLEAN NOT NULL DEFAULT FALSE,
      scheduled_for TIMESTAMP NOT NULL,
      delivered_at TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Inter-agent groups tables (migration 019)
  await query(`
    CREATE TABLE IF NOT EXISTS agent_groups (
      group_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      group_name VARCHAR(100) NOT NULL,
      description TEXT,
      encryption_salt VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, group_name)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS agent_group_members (
      group_id UUID NOT NULL REFERENCES agent_groups(group_id) ON DELETE CASCADE,
      agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, agent_id)
    )
  `);

}

async function seedUser(query, overrides = {}) {
  const userId = overrides.userId || uuidv4();
  const email = overrides.email || 'test@example.com';
  const apiKey = overrides.apiKey || `api-key-${userId.slice(0, 8)}`;
  const encryptionSalt = overrides.encryptionSalt || 'salt';
  const passwordHash = overrides.passwordHash || 'hash';
  const emailVerified = overrides.emailVerified ?? true;
  const scriptToken = overrides.scriptToken || `script-token-${userId.slice(0, 8)}`;

  await query(
    'INSERT INTO users (user_id, email, password_hash, api_key, script_token, encryption_salt, email_verified) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [userId, email, passwordHash, apiKey, scriptToken, encryptionSalt, emailVerified]
  );

  return { userId, email, apiKey, scriptToken };
}

/**
 * Apply agent lineage/spawning columns (migration 022).
 */
async function applyLineageSchema(query) {
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS spawn_depth INTEGER DEFAULT 0');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS initial_instructions TEXT');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS auto_spawned BOOLEAN DEFAULT FALSE');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS can_spawn BOOLEAN DEFAULT FALSE');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS inter_agent_mode VARCHAR(50) DEFAULT \'disabled\'');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_working BOOLEAN DEFAULT FALSE');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_working_heartbeat_at TIMESTAMP');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS reported_cli_version VARCHAR(32)');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS reported_cli_version_at TIMESTAMP');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_config JSONB DEFAULT \'{}\'');
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS allowed_permissions JSONB DEFAULT \'{}\'');
}

module.exports = {
  createTestDatabase,
  applyRuntimeUserColumns,
  applyEmailVerificationSchema,
  applyArchiveSchema,
  applyLineageSchema,
  seedUser,
};
