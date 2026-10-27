// Background start used to report success one second after tmux launched,
// even when the runner was crashing, already running, or could not decrypt
// messages. These tests run the generated CLI functions against a real tmux
// server (private socket) and fake runners, and pin that every outcome is
// either a confirmed connection or a visible error with the runner output.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { generateMainCLIScript, generateMessageHelperPython } = require('../../src/utils/apiGuideGenerator');
const { seal } = require('../../scripts/external-agent-bridge');

const SALT = Buffer.alloc(32, 9).toString('base64');
const cli = generateMainCLIScript('fixture-key', 'https://example.com', SALT);
const fn = name => {
  const match = cli.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  if (!match) throw new Error(`missing ${name}`);
  return match[0];
};
const fns = (...names) => names.map(fn).join('\n');
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const PASSWORD = 'p@ss $HOME "quoted" `tick` back\\slash \'single\' ${X}';
const keyFor = password => crypto.pbkdf2Sync(password, Buffer.from(SALT, 'base64'), 100000, 32, 'sha256').toString('base64');

let dir, socket;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-start-'));
  socket = `agent-start-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
});
afterEach(() => {
  if (hasTmux) spawnSync('tmux', ['-L', socket, 'kill-server']);
  fs.rmSync(dir, { recursive: true, force: true });
});

function bash(script, env = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail\n${script}`], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env }
  });
}

function startWith(runnerBody, { timeout = 20, tmuxConf = '/dev/null' } = {}) {
  const agentDir = path.join(dir, 'agent dir');
  fs.mkdirSync(path.join(agentDir, 'agent_state'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, '.env'), 'AGENT_NAME="knnn"\n');
  fs.writeFileSync(path.join(agentDir, 'agent-runner.sh'), `#!/usr/bin/env bash\n${runnerBody}\n`, { mode: 0o755 });
  return bash(`
    SCRIPT_DIR=${JSON.stringify(dir)}
    tmux() { command tmux -L "$SOCK" -f "$TMUX_CONF" "$@"; }
    systemctl() { return 1; }
    get_agent_folder() { echo knnn; }
    resolve_agent_dir() { printf '%s' "$AGENT_DIR"; }
    agent_is_running() { return 1; }
    ${fns('agent_session_name', 'agent_session_running', 'print_runner_log_tail', 'wait_for_agent_ready', 'start_agent_session')}
    start_agent_session knnn start
  `, { SOCK: socket, AGENT_DIR: agentDir, TMUX_CONF: tmuxConf, CHATSPACE_START_TIMEOUT: String(timeout) });
}

const maybe = hasTmux ? describe : describe.skip;
maybe('background start (real tmux)', () => {
  test('reports success only after the runner says it is connected', () => {
    const result = startWith('echo "[INFO] Waiting for messages... (Ctrl+C to stop)"; exec sleep 60');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('connected and waiting for messages');
    expect(result.stdout).toContain('runner.log');
    expect(fs.readFileSync(path.join(dir, 'agent dir/agent_state/runner.log'), 'utf8')).toContain('Waiting for messages');
    // The log can hold message text, so only the owner may read it.
    expect(fs.statSync(path.join(dir, 'agent dir/agent_state/runner.log')).mode & 0o077).toBe(0);
  });

  test('an invalid option in the user tmux.conf does not stop the agent', () => {
    // Older tmux rejects newer options such as cursor-style with "invalid
    // option", the message a user saw when attaching. Use an option no tmux
    // version knows so the config error is reproduced everywhere.
    const conf = path.join(dir, 'tmux.conf');
    fs.writeFileSync(conf, 'set -g chatspace-no-such-option on\n');
    expect(spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'new-session', '-d', 'sleep 2', ';', 'source-file', conf], { encoding: 'utf8' }).stderr).toContain('invalid option');
    spawnSync('tmux', ['-L', socket, 'kill-server']);
    const result = startWith('echo "Connected as knnn. Waiting for messages... (Ctrl+C to stop)"; exec sleep 60', { tmuxConf: conf });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('~/.tmux.conf');
  });

  test('a crashing runner fails loudly with its own error output', () => {
    const result = startWith('echo "[WARN] Sharing availability could not be checked; the supervisor will retry the connection" >&2; exit 1');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Error: 'knnn' did not start");
    expect(result.stdout).toContain('Sharing availability could not be checked');
    expect(result.stdout).toContain('keeps retrying every 10s');
  });

  test('a runner that exits cleanly at once (e.g. already running) is not reported as started', () => {
    const result = startWith('echo "This agent\'s shared listener is already running (PID 4242)."; exit 0');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('did not start');
    expect(result.stdout).toContain('already running (PID 4242)');
  });

  test('a wrong decryption password is reported with the fix command', () => {
    const result = startWith('echo "This agent cannot read your messages: the decryption password saved for it does not match your account." >&2; exec sleep 60');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('cannot read your messages');
    expect(result.stdout).toContain('--set-password "knnn"');
  });

  test('a runner that never confirms is reported with its output instead of success', () => {
    const result = startWith('echo "still preparing"; exec sleep 60', { timeout: 2 });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('has not confirmed a connection');
    expect(result.stdout).toContain('still preparing');
  });
});

describe('decryption password handling', () => {
  const samples = password => JSON.stringify({ samples: [seal('earlier message', keyFor(password))] });
  function verify(password, { response = samples(PASSWORD), curlExit = 0 } = {}) {
    return bash(`
      HAS_ENCRYPTION=true; ENCRYPTION_SALT=${JSON.stringify(SALT)}; API_KEY=k; API_BASE=https://example.invalid/api
      curl() { [ "$CURL_EXIT" = 0 ] || return "$CURL_EXIT"; printf '%s' "$RESPONSE"; }
      ${fn('verify_encryption_password')}
      rc=0; verify_encryption_password "$PW" || rc=$?; echo "rc=$rc"
    `, { PW: password, RESPONSE: response, CURL_EXIT: String(curlExit) });
  }

  test('checks the password locally against real account ciphertext', () => {
    expect(verify(PASSWORD).stdout).toContain('rc=0');
    expect(verify('typo').stdout).toContain('rc=1');
    expect(verify(PASSWORD, { response: '{"samples":[]}' }).stdout).toContain('rc=2');
    expect(verify(PASSWORD, { curlExit: 22 }).stdout).toContain('rc=2');
  });

  test('special-character passwords survive both bash and python-dotenv', () => {
    const envFile = path.join(dir, '.env');
    const written = bash(`${fns('env_quote', 'password_env_lines')}\npassword_env_lines "$PW" > "$ENV_FILE"`, { PW: PASSWORD, ENV_FILE: envFile });
    expect(written.status).toBe(0);
    const sourced = bash('set -a; . "$ENV_FILE"; printf %s "$USER_PASSWORD"', { ENV_FILE: envFile });
    expect(sourced.stdout).toBe(PASSWORD);
    const helper = generateMessageHelperPython(true);
    const envPassword = helper.match(/^def _env_password\(\):[\s\S]*?\n\n/m)[0];
    const python = spawnSync('python3', ['-c', `import base64, os, sys\nfrom dotenv import load_dotenv\nload_dotenv(sys.argv[1], override=True)\n${envPassword}\nsys.stdout.write(_env_password())`, envFile], { encoding: 'utf8' });
    if (/No module named .?dotenv/.test(python.stderr)) return;
    expect(python.stdout).toBe(PASSWORD);
  });

  function setPassword(password) {
    const agentDir = path.join(dir, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    if (!fs.existsSync(path.join(agentDir, '.env'))) fs.writeFileSync(path.join(agentDir, '.env'), 'USER_PASSWORD="typo"\nAPI_KEY="k"\nAGENT_NAME="knnn"\n', { mode: 0o600 });
    const result = bash(`
      HAS_ENCRYPTION=true; ENCRYPTION_SALT=${JSON.stringify(SALT)}; API_KEY=k; API_BASE=https://example.invalid/api
      SCRIPT_DIR=/opt/cli; ARG_PASSWORD="$PW"
      curl() { printf '%s' "$RESPONSE"; }
      print_success() { echo "OK: $*"; }; print_error() { echo "ERR: $*"; }; print_info() { echo "INFO: $*"; }; print_warning() { echo "WARN: $*"; }
      resolve_agent_dir() { printf '%s' "$AGENT_DIR"; }
      agent_is_running() { return 1; }
      ${fns('env_quote', 'password_env_lines', 'verify_encryption_password', 'report_password_check', 'prompt_encryption_password', 'set_agent_password')}
      ENCRYPTION_PASSWORD_HINT=hint
      set_agent_password knnn
    `, { PW: password, RESPONSE: samples(PASSWORD), AGENT_DIR: agentDir });
    return { result, env: fs.readFileSync(path.join(agentDir, '.env'), 'utf8'), agentDir };
  }

  test('--set-password refuses a password that does not match and leaves .env alone', () => {
    const { result, env } = setPassword('another typo');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('does not match your messages');
    expect(env).toBe('USER_PASSWORD="typo"\nAPI_KEY="k"\nAGENT_NAME="knnn"\n');
  });

  test('--set-password saves a verified password exactly and keeps other settings', () => {
    const { result, env, agentDir } = setPassword(PASSWORD);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Saved the new password for 'knnn'");
    expect(result.stdout).toContain('--start "knnn"');
    expect(env).toContain('API_KEY="k"');
    expect(env).toContain(`USER_PASSWORD_B64="${Buffer.from(PASSWORD).toString('base64')}"`);
    expect(env.match(/^USER_PASSWORD=/gm)).toHaveLength(1);
    expect(fs.statSync(path.join(agentDir, '.env')).mode & 0o077).toBe(0);
    expect(bash('set -a; . "$F"; printf %s "$USER_PASSWORD"', { F: path.join(agentDir, '.env') }).stdout).toBe(PASSWORD);
  });

  test('the CLI exposes --set-password and checks passwords before creating agents', () => {
    expect(cli).toContain('--set-password <name>');
    expect(cli).toMatch(/if \[ -n "\$ARG_SET_PASSWORD" \]; then\n\s+set_agent_password "\$ARG_SET_PASSWORD"/);
    expect(fn('create_agent')).toContain('prompt_encryption_password || return 1');
    expect(fn('create_agent_headless')).toContain('report_password_check "$password_check" || return 1');
    expect(cli).not.toMatch(/^USER_PASSWORD="\$user_password"$/m);
  });
});
