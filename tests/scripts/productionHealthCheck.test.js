const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/production_health_check.sh');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function makeHarness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-health-'));
  const rootDir = path.join(dir, 'app');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(rootDir);
  fs.mkdirSync(path.join(rootDir, 'tmp'));
  fs.mkdirSync(binDir);

  fs.writeFileSync(
    path.join(rootDir, '.env'),
    [
      'PORT=3000',
      'BASE_URL=https://chatmcp.space',
      '',
    ].join('\n')
  );

  writeExecutable(
    path.join(binDir, 'systemctl'),
    `#!/usr/bin/env bash
if [ "$1" = "is-active" ] && [ "$2" = "--quiet" ]; then
  exit ${options.systemdActive === false ? 3 : 0}
fi
if [ "$1" = "--user" ] && [ "$2" = "is-failed" ] && [ "$3" = "--quiet" ]; then
  exit ${options.backupFailed ? 0 : 1}
fi
exit 1
`
  );

  writeExecutable(
    path.join(binDir, 'curl'),
    `#!/usr/bin/env bash
url="\${@: -1}"
if [ "$url" = "http://127.0.0.1:3000/" ]; then
  printf '%s' '${options.appStatus || '200'}'
  exit ${options.appCurlExit || 0}
fi
if [ "$url" = "https://chatmcp.space" ]; then
  printf '%s' '${options.publicStatus || '200'}'
  exit ${options.publicCurlExit || 0}
fi
printf '000'
exit 7
`
  );

  writeExecutable(
    path.join(binDir, 'df'),
    `#!/usr/bin/env bash
cat <<'EOF'
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/root 100000 1000 99000 ${options.diskUsage || '1'}% /
EOF
`
  );

  if (options.recentCrashMarker) {
    fs.writeFileSync(
      path.join(rootDir, 'tmp/last_server_crash_alert.txt'),
      '[supervisor] Giving up after crashes\n'
    );
  }

  return { dir, rootDir, binDir };
}

function runHealthCheck(options = {}) {
  const harness = makeHarness(options);
  const result = spawnSync('bash', [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${harness.binDir}:${process.env.PATH}`,
      HEALTH_ROOT_DIR: harness.rootDir,
      REQUIRE_SYSTEMD_SERVICE: 'true',
      DISK_USAGE_MAX_PERCENT: '95',
      RECENT_CRASH_WINDOW_SECONDS: '3600',
    },
    encoding: 'utf8',
  });

  return result;
}

describe('production health check', () => {
  test('passes when service, upstream, public endpoint, crash marker, and disk are healthy', () => {
    const result = runHealthCheck();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK systemd service');
    expect(result.stdout).toContain('OK app upstream');
    expect(result.stdout).toContain('OK public nginx endpoint');
    expect(result.stdout).toContain('OK production health check');
  });

  test('fails when the supervised service is inactive', () => {
    const result = runHealthCheck({ systemdActive: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('systemd service');
    expect(result.stderr).toContain('not active');
  });

  test('fails when the local upstream cannot serve successful HTTP', () => {
    const result = runHealthCheck({ appStatus: '000', appCurlExit: 7 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('app upstream');
    expect(result.stderr).toContain('curl exit 7');
  });

  test('fails when nginx-facing public URL returns 502', () => {
    const result = runHealthCheck({ publicStatus: '502' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('public nginx endpoint');
    expect(result.stderr).toContain('HTTP 502');
  });

  test('fails when disk usage is above the configured threshold', () => {
    const result = runHealthCheck({ diskUsage: '98' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('disk usage');
    expect(result.stderr).toContain('98% used');
  });

  test('fails when a recent supervisor crash marker exists', () => {
    const result = runHealthCheck({ recentCrashMarker: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('crash marker');
    expect(result.stderr).toContain('recent supervisor alert');
  });

  test('fails when the most recent database backup failed', () => {
    const result = runHealthCheck({ backupFailed: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('database backup');
    expect(result.stderr).toContain('last run failed');
  });
});
