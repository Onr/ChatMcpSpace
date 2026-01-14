/**
 * Helper to ensure the agents.last_seen_at column exists.
 * This allows older databases to be auto-migrated during startup.
 */

const { query } = require('../connection');
const { logInfo, logWarn } = require('../../utils/logger');

const MIGRATION_NAME = '009_add_last_seen_at';

async function columnExists(tableName, columnName) {
  const result = await query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return result.rowCount > 0;
}

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS migrations (
      migration_name TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function ensureLastSeenAtColumn() {
  let schemaUpdated = false;

  const hasLastSeenAt = await columnExists('agents', 'last_seen_at');
  if (!hasLastSeenAt) {
    logInfo('migration.last_seen_at', { table: 'agents', action: 'add_column' });
    await query('ALTER TABLE agents ADD COLUMN last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
    schemaUpdated = true;
  }

  try {
    await query('CREATE INDEX IF NOT EXISTS idx_agents_last_seen_at ON agents(last_seen_at DESC)');
    await query(
      "COMMENT ON COLUMN agents.last_seen_at IS 'Timestamp when agent was last active (sent message or polled for responses)'"
    );
  } catch (error) {
    logWarn('migration.last_seen_at_index_failed', { error: error.message });
  }

  await ensureMigrationsTable();
  await query(
    `INSERT INTO migrations (migration_name)
     VALUES ($1)
     ON CONFLICT (migration_name) DO NOTHING`,
    [MIGRATION_NAME]
  );

  return schemaUpdated;
}

module.exports = {
  ensureLastSeenAtColumn,
};
