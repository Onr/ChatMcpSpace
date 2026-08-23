/**
 * Automatic Migration Runner
 * Runs all SQL migrations in order on application startup
 * This ensures database schema is always up-to-date across all environments
 */

const fs = require('fs');
const path = require('path');
const { query, getClient } = require('./connection');
const { logInfo, logError, logWarn } = require('../utils/logger');

const MIGRATION_RENAMES = Object.freeze({
  '004a_priority_to_integer.sql': ['004_priority_to_integer.sql'],
  '004b_add_user_responses_read_tracking.sql': ['004_add_user_responses_read_tracking.sql'],
  '006a_add_agent_type.sql': ['006_add_agent_type.sql'],
  '006b_add_google_auth.sql': ['006_add_google_auth.sql'],
  '024a_add_agent_working_heartbeat.sql': ['024_add_agent_working_heartbeat.sql'],
  '024b_add_external_bot_connections.sql': ['024_add_external_bot_connections.sql'],
  '029_add_email_verification.sql': ['add_email_verification.sql'],
});

function parseMigrationPrefix(filename) {
  const match = filename.match(/^(\d+)([a-z]?)_/i);
  if (!match) {
    return { number: Number.POSITIVE_INFINITY, suffix: '', filename };
  }

  return {
    number: parseInt(match[1], 10),
    suffix: match[2].toLowerCase(),
    filename,
  };
}

/**
 * Get all migration files in order
 * Files are sorted by numeric prefix and optional alpha suffix (004a, 004b).
 */
function getMigrationFiles() {
  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort((a, b) => {
      const aPrefix = parseMigrationPrefix(a);
      const bPrefix = parseMigrationPrefix(b);

      if (aPrefix.number !== bPrefix.number) {
        return aPrefix.number - bPrefix.number;
      }

      if (aPrefix.suffix !== bPrefix.suffix) {
        return aPrefix.suffix.localeCompare(bPrefix.suffix);
      }

      return a.localeCompare(b);
    });

  return files;
}

/**
 * Initialize migrations table if it doesn't exist
 */
async function initializeMigrationsTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS migrations (
        migration_name TEXT PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    logInfo('migrations.table_check', { status: 'initialized' });
  } catch (error) {
    logError('migrations.table_init_failed', { error: error.message });
    throw error;
  }
}

/**
 * Check if a migration has already been applied
 */
async function isMigrationApplied(migrationName) {
  try {
    const result = await query(
      'SELECT 1 FROM migrations WHERE migration_name = $1',
      [migrationName]
    );
    return result.rows.length > 0;
  } catch (error) {
    // Table might not exist yet, return false
    logWarn('migrations.check_failed', { migration: migrationName, error: error.message });
    return false;
  }
}

async function getAppliedMigrationName(migrationName) {
  if (await isMigrationApplied(migrationName)) {
    return migrationName;
  }

  for (const previousName of MIGRATION_RENAMES[migrationName] || []) {
    if (await isMigrationApplied(previousName)) {
      return previousName;
    }
  }

  return null;
}

/**
 * Mark a migration as applied
 */
async function markMigrationApplied(migrationName) {
  try {
    await query(
      'INSERT INTO migrations (migration_name) VALUES ($1) ON CONFLICT (migration_name) DO NOTHING',
      [migrationName]
    );
  } catch (error) {
    logError('migrations.mark_failed', { migration: migrationName, error: error.message });
    throw error;
  }
}

/**
 * Run a single migration file
 */
async function runMigration(filename) {
  const client = await getClient();
  const filePath = path.join(__dirname, 'migrations', filename);

  try {
    logInfo('migrations.start', { migration: filename });

    const sql = fs.readFileSync(filePath, 'utf8');

    // Run migration in transaction
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');

    // Mark as applied
    await markMigrationApplied(filename);

    logInfo('migrations.complete', { migration: filename, status: 'success' });
    console.log(`✓ Migration ${filename} completed successfully`);

    return true;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logError('migrations.rollback_failed', { migration: filename, error: rollbackError.message });
    }

    logError('migrations.failed', { migration: filename, error: error.message });
    console.error(`✗ Migration ${filename} failed:`, error.message);

    // Don't throw - log and continue so we see all migration errors
    return false;
  } finally {
    client.release();
  }
}

/**
 * Run all pending migrations
 */
async function runAllMigrations() {
  try {
    // Initialize migrations table first
    await initializeMigrationsTable();

    const migrationFiles = getMigrationFiles();

    if (migrationFiles.length === 0) {
      logWarn('migrations.none_found', { path: path.join(__dirname, 'migrations') });
      console.log('No migration files found in migrations directory');
      return true;
    }

    let failedMigrations = [];
    let completedCount = 0;
    let skippedCount = 0;

    console.log(`\nRunning ${migrationFiles.length} migrations...\n`);

    for (const filename of migrationFiles) {
      const appliedAs = await getAppliedMigrationName(filename);

      if (appliedAs) {
        if (appliedAs !== filename) {
          await markMigrationApplied(filename);
          logInfo('migrations.skipped', {
            migration: filename,
            reason: 'renamed_migration_already_applied',
            appliedAs,
          });
          console.log(`⊘ Migration ${filename} already applied as ${appliedAs} (recorded rename)`);
        } else {
          logInfo('migrations.skipped', { migration: filename, reason: 'already_applied' });
          console.log(`⊘ Migration ${filename} already applied (skipping)`);
        }
        skippedCount++;
      } else {
        const success = await runMigration(filename);
        if (!success) {
          failedMigrations.push(filename);
        } else {
          completedCount++;
        }
      }
    }

    console.log(`\nMigration Summary:`);
    console.log(`  Completed: ${completedCount}`);
    console.log(`  Skipped: ${skippedCount}`);
    console.log(`  Failed: ${failedMigrations.length}`);

    if (failedMigrations.length > 0) {
      const message = `Migrations failed: ${failedMigrations.join(', ')}`;
      logError('migrations.some_failed', { migrations: failedMigrations });
      console.error(`\n⚠ Some migrations failed. Please check the errors above.`);
      console.error(`Failed migrations: ${failedMigrations.join(', ')}\n`);
      // Return false to indicate failure but don't crash
      return false;
    }

    logInfo('migrations.all_complete', { completed: completedCount, skipped: skippedCount });
    console.log(`\n✓ All migrations completed successfully!\n`);
    return true;
  } catch (error) {
    logError('migrations.runner_error', { error: error.message });
    console.error('Migration runner error:', error.message);
    return false;
  }
}

/**
 * Ensure archive tables exist
 * This is called separately to provide detailed feedback about archive setup
 */
async function ensureArchiveTables() {
  try {
    // Check if archived_agents table exists
    const checkArchiveResult = await query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'archived_agents'
      ) as exists
    `);

    if (checkArchiveResult.rows[0].exists) {
      logInfo('archive.tables_exist', { status: 'verified' });
      return true;
    }

    logWarn('archive.tables_missing', { status: 'will_be_created_by_migration' });
    return false;
  } catch (error) {
    logError('archive.check_failed', { error: error.message });
    return false;
  }
}

module.exports = {
  runAllMigrations,
  ensureArchiveTables,
  getMigrationFiles,
  parseMigrationPrefix,
  MIGRATION_RENAMES,
  runMigration,
  isMigrationApplied
};
