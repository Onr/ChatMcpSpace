'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readJSON, readJSONLines } = require('./protocol');

function taskContainerIds(files, records) {
  const mounts = new Set([files.inputRoot + ':/task-inputs:ro,nosuid,nodev,noexec',
    files.outputRoot + ':/task-outputs:rw,nosuid,nodev,noexec']);
  const creates = records.filter(record => record.event === 'invoke' && record.phase === 'create' &&
    record.argv.some((arg, i) => arg === '--volume' && mounts.has(record.argv[i + 1])));
  return creates.map(create => {
    const exit = records.find(record => record.call === create.call && record.event === 'exit');
    const id = exit?.stdout?.trim();
    if (exit?.code !== 0 || !/^[a-f0-9]{64}$/.test(id || '')) throw Error('Task file cleanup identity is unknown; retain paths');
    return id;
  });
}

function cleanupTaskFiles(files, root = __dirname) {
  const metadata = readJSON(path.join(root, 'verification-round.json'));
  if (fs.readFileSync('/etc/agent-sharing-verification-guest', 'utf8').trim() !== metadata.roundId) {
    throw Error('Task file cleanup requires the dedicated verification guest');
  }
  const records = readJSONLines(path.join(root, 'evidence', 'engine-phases.jsonl'));
  const ids = taskContainerIds(files, records);
  const environment = Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  for (const id of ids) {
    let absent = false;
    try {
      execFileSync('/usr/bin/podman', ['--remote=false', 'container', 'exists', id], {
        env: environment, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 16384, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      absent = error.status === 1 && !error.signal && error.stdout === '' && error.stderr === '';
    }
    if (!absent) throw Error('Exact task container absence is uncertain; retain task file paths');
  }
  fs.appendFileSync(path.join(root, 'evidence', 'task-files-cleanup.jsonl'), JSON.stringify({
    at: new Date().toISOString(), ids, paths: [files.root, files.inputRoot, files.outputRoot], exactAbsent: true
  }) + '\n', { mode: 0o600 });
  files.cleanup();
}

module.exports = { taskContainerIds, cleanupTaskFiles };
