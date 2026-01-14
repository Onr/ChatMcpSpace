/**
 * Helper to ensure encryption flag columns exist on messages tables.
 * This allows older databases to be auto-migrated during startup.
 */

const { query } = require('../connection');
const { logInfo, logWarn } = require('../../utils/logger');

const MIGRATION_NAME = '005_add_encryption_support';

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

async function ensureEncryptionColumns() {
  let schemaUpdated = false;

  const hasMessageColumn = await columnExists('messages', 'encrypted');
  if (!hasMessageColumn) {
    logInfo('migration.encrypt_columns', { table: 'messages', action: 'add_column' });
    await query('ALTER TABLE messages ADD COLUMN encrypted BOOLEAN DEFAULT FALSE');
    schemaUpdated = true;
  }

  const hasUserMessageColumn = await columnExists('user_messages', 'encrypted');
  if (!hasUserMessageColumn) {
    logInfo('migration.encrypt_columns', { table: 'user_messages', action: 'add_column' });
    await query('ALTER TABLE user_messages ADD COLUMN encrypted BOOLEAN DEFAULT FALSE');
    schemaUpdated = true;
  }

  try {
    await query('CREATE INDEX IF NOT EXISTS idx_messages_encrypted ON messages(encrypted)');
    await query('CREATE INDEX IF NOT EXISTS idx_user_messages_encrypted ON user_messages(encrypted)');
  } catch (error) {
    logWarn('migration.encrypt_columns_index_failed', { error: error.message });
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
  ensureEncryptionColumns,
};
