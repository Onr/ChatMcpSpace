/**
 * Automatic Migration Runner
 * Runs all SQL migrations in order on application startup
 * This ensures database schema is always up-to-date across all environments
 */

const fs = require('fs');
const path = require('path');
const { query, getClient } = require('./connection');
const { logInfo, logError, logWarn } = require('../utils/logger');

/**
 * Get all migration files in order
 * Files are sorted numerically to ensure correct execution order
 */
function getMigrationFiles() {
  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort((a, b) => {
      // Extract numeric prefix for proper sorting
      const aMatch = a.match(/^\d+/);
      const bMatch = b.match(/^\d+/);
      const aNum = parseInt((aMatch && aMatch[0]) || '0', 10);
      const bNum = parseInt((bMatch && bMatch[0]) || '0', 10);
      return aNum - bNum;
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
      const applied = await isMigrationApplied(filename);

      if (applied) {
        logInfo('migrations.skipped', { migration: filename, reason: 'already_applied' });
        console.log(`⊘ Migration ${filename} already applied (skipping)`);
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
  runMigration,
  isMigrationApplied
};
