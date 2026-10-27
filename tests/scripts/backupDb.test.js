const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('backup_db.sh', () => {
  function fixture(dump, extraEnv = '') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-failure-'));
    const scripts = path.join(dir, 'scripts');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(scripts);
    fs.mkdirSync(bin);
    for (const name of ['backup_db.sh', '_common.sh']) {
      fs.copyFileSync(path.join(repoRoot, 'scripts', name), path.join(scripts, name));
    }
    fs.writeFileSync(path.join(dir, '.env'), `DB_NAME=backup_test\n${extraEnv}`);
    writeExecutable(path.join(bin, 'pg_dump'), `#!/usr/bin/env bash\n${dump}\n`);
    return { dir, scripts, bin };
  }

  test('a failed dump does not publish a partial backup', () => {
    const { dir, scripts, bin } = fixture('printf partial; exit 1');
    try {
      const result = spawnSync('bash', [path.join(scripts, 'backup_db.sh')], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(fs.readdirSync(path.join(dir, 'backups'))).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('off-site failure preserves the complete local backup and fails the job', () => {
    const { dir, scripts, bin } = fixture('printf complete', 'SUPABASE_BACKUP_ENABLED=true\n');
    writeExecutable(path.join(bin, 'python3'), '#!/usr/bin/env bash\nexit 1\n');
    try {
      const result = spawnSync('bash', [path.join(scripts, 'backup_db.sh')], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      const files = fs.readdirSync(path.join(dir, 'backups'));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.sql\.gz$/);
      expect(fs.statSync(path.join(dir, 'backups', files[0])).mode & 0o777).toBe(0o600);
      expect(result.stdout).not.toContain('Backup completed.');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  function runWithOldDump(extraEnv, python) {
    const { dir, scripts, bin } = fixture('printf complete', extraEnv);
    if (python) writeExecutable(path.join(bin, 'python3'), `#!/usr/bin/env bash\n${python}\n`);
    fs.mkdirSync(path.join(dir, 'backups'));
    const old = path.join(dir, 'backups', 'backup_test_20261001T000000Z.sql.gz');
    fs.writeFileSync(old, 'old');
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000);
    fs.utimesSync(old, fiveDaysAgo, fiveDaysAgo);
    const result = spawnSync('bash', [path.join(scripts, 'backup_db.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
    });
    const files = fs.readdirSync(path.join(dir, 'backups'));
    fs.rmSync(dir, { recursive: true, force: true });
    return { result, files };
  }

  test('verified off-site upload shortens local retention to 3 days', () => {
    const { result, files } = runWithOldDump('SUPABASE_BACKUP_ENABLED=true\n', 'exit 0');
    expect(result.status).toBe(0);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toBe('backup_test_20261001T000000Z.sql.gz');
  });

  test('local-only backups keep 14 days', () => {
    const { result, files } = runWithOldDump('');
    expect(result.status).toBe(0);
    expect(files).toContain('backup_test_20261001T000000Z.sql.gz');
    expect(files).toHaveLength(2);
  });

  test('failed off-site upload still prunes with the 14-day window and fails the job', () => {
    const { result, files } = runWithOldDump('SUPABASE_BACKUP_ENABLED=true\n', 'exit 1');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('keeping 14 days locally');
    expect(files).toContain('backup_test_20261001T000000Z.sql.gz');
    expect(files).toHaveLength(2);
  });

  test('invalid off-site local retention falls back to 14 days', () => {
    const { result, files } = runWithOldDump(
      'SUPABASE_BACKUP_ENABLED=true\nBACKUP_LOCAL_RETENTION_DAYS_WITH_OFFSITE=0\n', 'exit 0');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('keeping 14 days');
    expect(files).toHaveLength(2);
  });

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
