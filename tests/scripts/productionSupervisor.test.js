const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const supervisorPath = path.join(repoRoot, 'scripts/run_production_supervised.sh');

describe('production supervisor restart semantics', () => {
  let source;

  beforeAll(() => {
    source = fs.readFileSync(supervisorPath, 'utf8');
  });

  test('database preflight failure exits nonzero so systemd can retry', () => {
    expect(source).toMatch(
      /warn_crash "\[supervisor\] Database connection failed\. Not starting server\."\s+exit 1/
    );
  });

  test('unexpected clean server exit is treated as a restart-worthy failure', () => {
    expect(source).toMatch(
      /if \[ "\$exit_code" -eq 0 \]; then\s+warn_crash "\[supervisor\] Server exited cleanly but unexpectedly\. Restarting through systemd\."\s+exit 1\s+fi/
    );
  });

  test('SIGTERM exit 143 is treated as an intentional shutdown, not a crash', () => {
    expect(source).toMatch(
      /if \[ "\$exit_code" -eq 143 \]; then\s+log_line "\[supervisor\] Server stopped by SIGTERM \(exit 143\)\."\s+exit 0\s+fi/
    );
    expect(source).not.toMatch(/warn_crash "\[supervisor\] Server stopped by SIGTERM/);
  });

  test('max crash exhaustion exits nonzero instead of silently stopping service', () => {
    expect(source).toMatch(
      /Giving up after \$failure_count crashes within \${RESTART_WINDOW_SECONDS}s[\s\S]*exit 1\s+fi/
    );
    expect(source).not.toMatch(/Giving up after \$failure_count crashes within \${RESTART_WINDOW_SECONDS}s[\s\S]*exit 0\s+fi/);
  });
});
