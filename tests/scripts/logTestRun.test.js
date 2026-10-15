const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/log_test_run.sh');

function runLogger(args, logFile) {
  return spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CHATMCP_TEST_LOG: logFile }
  });
}

describe('log_test_run.sh', () => {
  let dir;
  let logFile;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-run-log-'));
    logFile = path.join(dir, 'nested', 'TEST_RUN_LOG.md');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the log with a table header on first use', () => {
    const result = runLogger(['jest', '0', '10 tests'], logFile);
    expect(result.status).toBe(0);

    const contents = fs.readFileSync(logFile, 'utf8');
    expect(contents).toMatch(/# Test run log/);
    expect(contents).toMatch(/\| UTC time \| Suite \| Result \| Details \| Commit \| Branch \|/);
    // The header the script regenerates must match docs/TEST_RUN_LOG.md, or a
    // deleted log comes back missing the legend that explains the rows.
    expect(contents).toMatch(/What each suite proves/);
    expect(contents).toMatch(/e2e:create-agent/);
  });

  it('records a zero exit code as PASS and a non-zero one as FAIL', () => {
    runLogger(['jest', '0', 'all green'], logFile);
    runLogger(['e2e:create-agent', '1', '26/27 checks passed'], logFile);

    const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-2);
    expect(rows[0]).toContain('| jest | PASS | all green |');
    expect(rows[1]).toContain('| e2e:create-agent | FAIL | 26/27 checks passed |');
  });

  it('appends rather than overwriting, so history is preserved', () => {
    runLogger(['jest', '0', 'first'], logFile);
    runLogger(['jest', '0', 'second'], logFile);

    const contents = fs.readFileSync(logFile, 'utf8');
    expect(contents).toContain('first');
    expect(contents).toContain('second');
    expect(contents.match(/# Test run log/g)).toHaveLength(1);
  });

  it('escapes pipes and newlines so one run stays one table row', () => {
    runLogger(['jest', '0', 'suites: 1 passed | tests: 2\npassed'], logFile);

    const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const lastRow = rows[rows.length - 1];
    expect(lastRow).toContain('tests: 2 passed');
    expect(lastRow).toContain('\\|');
    // A stray newline would have split the details across two lines.
    expect(rows.filter((r) => r.includes('suites: 1 passed'))).toHaveLength(1);
  });

  it('stamps the row with the current commit and branch', () => {
    runLogger(['jest', '0', 'x'], logFile);

    const commit = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
      .stdout.trim();
    const lastRow = fs.readFileSync(logFile, 'utf8').trim().split('\n').pop();
    expect(lastRow).toContain(commit);
  });

  it('rejects a call that omits the exit code', () => {
    const result = runLogger(['jest'], logFile);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage:/);
  });
});

describe('run_tests.sh', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts/run_tests.sh'), 'utf8');

  it('reads jest exit status from PIPESTATUS, not the tee pipeline', () => {
    // tee always exits 0, so trusting $? here would log every red run as a pass.
    expect(script).toMatch(/TEST_EXIT=\$\{PIPESTATUS\[0\]\}/);
  });

  it('logs the run and then exits with the suite status', () => {
    expect(script).toMatch(/log_test_run\.sh" "jest" "\$TEST_EXIT"/);
    expect(script).toMatch(/exit "\$TEST_EXIT"/);
  });
});
