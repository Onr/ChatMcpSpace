#!/usr/bin/env node

/**
 * Retention for agent_auth_events.
 *
 * - auth_success rows older than --success-days (default 30) are deleted, except
 *   each agent's newest success, which the external-bot handshake check reads.
 * - Other event types (scope denials, agent mismatches, unmapped routes) are
 *   kept for --other-days (default 90).
 *
 * Deletes run in small batches so WAL and lock pressure stay low.
 *
 * Usage: node scripts/prune_auth_events.js [--success-days N] [--other-days N]
 *          [--batch-size N] [--dry-run]
 */

const path = require('path');

const DEFAULTS = { successDays: 30, otherDays: 90, batchSize: 10000, dryRun: false };

// Each agent's newest success is computed once per statement; a correlated
// EXISTS per row is far too slow on a large table without a composite index.
const SUCCESS_FROM = `
  agent_auth_events e
  JOIN (
    SELECT agent_id, MAX(created_at) AS newest_at
    FROM agent_auth_events
    WHERE event_type = 'auth_success'
    GROUP BY agent_id
  ) newest ON newest.agent_id = e.agent_id`;

const SUCCESS_WHERE = `
  e.event_type = 'auth_success'
  AND e.created_at < NOW() - ($1::float8 * INTERVAL '1 day')
  AND e.created_at < newest.newest_at`;

const OTHER_FROM = 'agent_auth_events e';

const OTHER_WHERE = `
  e.event_type <> 'auth_success'
  AND e.created_at < NOW() - ($1::float8 * INTERVAL '1 day')`;

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const numeric = { '--success-days': 'successDays', '--other-days': 'otherDays', '--batch-size': 'batchSize' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (numeric[arg]) {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${arg} needs a non-negative number`);
      }
      options[numeric[arg]] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.batchSize < 1) {
    throw new Error('--batch-size must be at least 1');
  }
  return options;
}

async function deleteInBatches(query, from, where, days, batchSize) {
  let total = 0;
  for (;;) {
    const result = await query(
      `DELETE FROM agent_auth_events
       WHERE event_id IN (
         SELECT e.event_id FROM ${from}
         WHERE ${where}
         LIMIT $2
       )`,
      [days, batchSize]
    );
    total += result.rowCount;
    if (result.rowCount < batchSize) {
      return total;
    }
  }
}

async function countMatching(query, from, where, days) {
  const result = await query(`SELECT COUNT(*)::int AS count FROM ${from} WHERE ${where}`, [days]);
  return result.rows[0].count;
}

async function pruneAuthEvents(query, options = {}) {
  const { successDays, otherDays, batchSize, dryRun } = { ...DEFAULTS, ...options };
  if (dryRun) {
    return {
      dryRun: true,
      authSuccess: await countMatching(query, SUCCESS_FROM, SUCCESS_WHERE, successDays),
      other: await countMatching(query, OTHER_FROM, OTHER_WHERE, otherDays)
    };
  }
  return {
    dryRun: false,
    authSuccess: await deleteInBatches(query, SUCCESS_FROM, SUCCESS_WHERE, successDays, batchSize),
    other: await deleteInBatches(query, OTHER_FROM, OTHER_WHERE, otherDays, batchSize)
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
  const { query, pool } = require('../src/db/connection');
  try {
    const result = await pruneAuthEvents(query, options);
    const verb = result.dryRun ? 'would delete' : 'deleted';
    console.log(`[prune-auth-events] ${verb} ${result.authSuccess} auth_success rows older than ${options.successDays} days and ${result.other} other rows older than ${options.otherDays} days`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[prune-auth-events] failed:', error.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, pruneAuthEvents };
