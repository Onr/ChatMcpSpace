'use strict';

// Keep PostgreSQL SQL unchanged. pg-mem neither models the upgrade's original
// inline constraint name nor reliably excludes a partial index from unrelated
// lookups. Real PostgreSQL alone verifies active-attempt uniqueness/migrations.
function migrationForFixture(sql, realPostgres) {
  if (realPostgres) return sql;
  return sql.replace('first_message_id UUID NOT NULL UNIQUE REFERENCES', 'first_message_id UUID NOT NULL REFERENCES')
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS shared_tasks_one_active_attempt ON shared_tasks\(first_message_id\)\s+WHERE state IN \('queued','running','waiting_for_approval','paused','cancellation_requested'\);/, '');
}

module.exports = { migrationForFixture };
