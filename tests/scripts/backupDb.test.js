const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('backup_db.sh', () => {
  test('backs up when a plain .env value contains spaces without evaluating it as shell', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-db-'));
    const scriptsDir = path.join(dir, 'scripts');
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(scriptsDir);
    fs.mkdirSync(binDir);
    fs.copyFileSync(path.join(repoRoot, 'scripts/backup_db.sh'), path.join(scriptsDir, 'backup_db.sh'));
    fs.copyFileSync(path.join(repoRoot, 'scripts/_common.sh'), path.join(scriptsDir, '_common.sh'));
    fs.chmodSync(path.join(scriptsDir, 'backup_db.sh'), 0o755);
    fs.writeFileSync(path.join(dir, '.env'), [
      'DB_NAME=backup_test',
      'DB_USER=test_user',
      'EMAIL_FROM_NAME=ChatMCPSpace Agent Messaging Platform',
      'MALFORMED LINE',
      '',
    ].join('\n'));
    writeExecutable(path.join(binDir, 'pg_dump'), '#!/usr/bin/env bash\nprintf -- "-- mock database dump --\\n"\n');

    const result = spawnSync('bash', [path.join(scriptsDir, 'backup_db.sh')], {
      cwd: dir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Ignoring malformed .env line');
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^backup_test_\d{8}T\d{6}Z\.sql\.gz$/);
  });
});
