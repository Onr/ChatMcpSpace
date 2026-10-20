const { spawnSync } = require('child_process');
const { generateMainCLIScript, generateAgentRunner } = require('../../src/utils/apiGuideGenerator');

const cli = generateMainCLIScript('fixture', 'https://example.com', 'fixture-salt');
const runner = generateAgentRunner();
const foreground = cli.match(/^start_agent_foreground\(\) \{[\s\S]*?^\}/m)[0];
const validate = runner.match(/^validate_config\(\) \{[\s\S]*?^\}/m)[0];
function bash(script, env = {}) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
}
function runningAgent({ headless = false, session = false, choice = 'Restart in background', restartExit = 0 } = {}) {
  return bash(`
    ARG_HEADLESS=${headless}; SCRIPT_DIR='/tmp/project with spaces'
    agent_session_name() { echo fixture-local-agent; }
    agent_is_running() { return 0; }
    agent_session_running() { ${session ? 'return 0' : 'return 1'}; }
    gum() { printf '%s\\n' "$CHOICE"; }
    start_agent_session() { printf 'RESTART:%s:%s\\n' "$1" "$2"; return ${restartExit}; }
    tmux() { printf 'TMUX:%s:%s:%s\\n' "$1" "$2" "$3"; }
    ${foreground}
    start_agent_foreground 'Agent With Spaces' /nonexistent
  `, { CHOICE: choice });
}

test('continuing a running service/orphan can restart the existing supervisor', () => {
  const result = runningAgent();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('RESTART:Agent With Spaces:restart');
});
test('restart failures propagate to the caller', () => {
  expect(runningAgent({ restartExit: 7 }).status).toBe(7);
});
test('existing tmux session can be attached without a second runner', () => {
  const result = runningAgent({ session: true, choice: 'Attach to running agent' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('TMUX:attach-session:-t:=fixture-local-agent');
  expect(result.stdout).not.toContain('RESTART:');
});
test('cancel leaves the existing runner alone', () => {
  expect(runningAgent({ choice: 'Cancel' }).stdout).toBe('');
});
test('headless continue does not restart automatically or advertise a missing tmux session', () => {
  const result = runningAgent({ headless: true });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--restart "Agent With Spaces"');
  expect(result.stdout).not.toMatch(/RESTART:|Attach:/);
});

const agyStart = runner.indexOf('            local agy_args=()');
const agyArgs = runner.slice(agyStart, runner.indexOf('            local prompt_text', agyStart));
function antigravity(approval, sandbox, allowed) {
  return bash(`
    MODEL_PROVIDER=antigravity; MODEL=fixture; PROJECT_ROOT=/tmp
    CONFIG_FILE=/nonexistent; THINKING_EFFORT=medium
    log() { :; }; reset_config_error_state() { :; }; report_config_error() { return 0; }
    ${validate}
    args() { ${agyArgs}\n printf '%s\\n' "\${agy_args[@]}"; }
    validate_config || exit 3
    args
  `, {
    APPROVAL_MODE: approval, SANDBOX_MODE: sandbox,
    ALLOWED_PERMISSIONS: JSON.stringify({ antigravity: { '--sandbox': ['workspace-write', 'danger-full-access'], '--dangerously-skip-permissions': allowed } })
  });
}
test.each(['full-auto', 'bypassPermissions'])('%s honors the existing Antigravity skip permission', approval => {
  const result = antigravity(approval, 'none', true);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--dangerously-skip-permissions');
});
test.each(['full-auto', 'bypassPermissions'])('%s cannot bypass denied owner permission', approval => {
  expect(antigravity(approval, 'none', false).status).toBe(3);
});
test.each(['default', 'acceptEdits'])('%s preserves interactive permission policy', approval => {
  expect(antigravity(approval, 'none', true).stdout).not.toContain('--dangerously-skip-permissions');
});
test('sandboxed Antigravity remains sandboxed with the approval alias', () => {
  const result = antigravity('bypassPermissions', 'workspace-write', true);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--sandbox');
  expect(result.stdout).not.toContain('--dangerously-skip-permissions');
});
