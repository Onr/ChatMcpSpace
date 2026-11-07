const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function runNotify(helperOutput, helperExit = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-alert-'));
  const scripts = path.join(dir, 'scripts');
  const bin = path.join(dir, 'bin');
  const agentDir = path.join(dir, 'agent');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(scripts);
  fs.mkdirSync(bin);
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, 'message_helper.py'), '');
  for (const name of ['health_alert_notify.sh', '_common.sh']) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', name), path.join(scripts, name));
  }
  writeExecutable(path.join(scripts, 'disk_pressure_cleanup.sh'), '#!/usr/bin/env bash\necho "skipped: below threshold"\n');
  writeExecutable(path.join(scripts, 'production_health_check.sh'), '#!/usr/bin/env bash\necho "FAIL backup"\nexit 1\n');
  writeExecutable(path.join(bin, 'uv'), `#!/usr/bin/env bash\necho '${helperOutput}'\nexit ${helperExit}\n`);

  const result = spawnSync('bash', [path.join(scripts, 'health_alert_notify.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HEALTH_ALERT_AGENT_DIR: agentDir,
      HEALTH_ALERT_STATE_DIR: stateDir
    }
  });
  return { ...result, cooldownStarted: fs.existsSync(path.join(stateDir, 'last-alert')) };
}

describe('health_alert_notify.sh', () => {
  it('starts the cooldown only after the alert is delivered', () => {
    const result = runNotify('Message sent successfully.');
    expect(result.status).toBe(0);
    expect(result.cooldownStarted).toBe(true);
  });

  it('reports a helper that prints a failure but exits 0, so the next run retries', () => {
    const result = runNotify('Failed to send: stop the legacy listener');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to send chat alert: Failed to send');
    expect(result.cooldownStarted).toBe(false);
  });

  it('reports a helper that exits nonzero', () => {
    const result = runNotify('boom', 3);
    expect(result.status).toBe(1);
    expect(result.cooldownStarted).toBe(false);
  });
});
