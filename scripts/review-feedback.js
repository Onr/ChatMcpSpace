#!/usr/bin/env node
'use strict';

// Internal, read-only review. Closed records remain available with --all.
async function listFeedback(db, { all = false } = {}) {
  return (await db.query(`SELECT feedback_id, created_at, triage_status, message, triage_note,
    image_content_type, octet_length(image_data) AS image_bytes
    FROM feedback ${all ? '' : "WHERE triage_status IN ('new', 'in_progress')"}
    ORDER BY created_at ASC, feedback_id ASC`)).rows;
}

if (require.main === module) {
  if (process.argv.slice(2).some(arg => arg !== '--all')) {
    console.error('Usage: node scripts/review-feedback.js [--all]');
    process.exitCode = 1;
  } else {
    require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
    const db = require('../src/db/connection');
    listFeedback(db, { all: process.argv.includes('--all') })
      .then(rows => console.log(JSON.stringify(rows, null, 2)))
      .catch(error => { console.error(error.message); process.exitCode = 1; })
      .finally(() => db.closePool());
  }
}

module.exports = { listFeedback };
