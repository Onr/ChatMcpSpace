#!/usr/bin/env node
require('dotenv').config();
const { closePool } = require('./src/db/connection');
const { ensureEncryptionColumns } = require('./src/db/migrations/encryptionColumns');

async function runMigration() {
  try {
    console.log('\n=== Running Encryption Support Migration (005) ===\n');

    const updated = await ensureEncryptionColumns();

    if (updated) {
      console.log('Schema updated successfully. Messages and user messages now track encrypted payloads.');
    } else {
      console.log('Schema already up to date. No changes were required.');
    }

    console.log('\n✅ Migration 005 completed successfully!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('Error details:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

runMigration();
