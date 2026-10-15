#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { runAllMigrations } = require('../src/db/runMigrations');
const { closePool } = require('../src/db/connection');

async function main() {
  const success = await runAllMigrations();
  if (!success) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error('[migrate] Migration run failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
