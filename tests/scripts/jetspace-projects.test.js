const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateMainCLIScript } = require('../../src/utils/apiGuideGenerator');
const source = generateMainCLIScript('fixture-key', 'https://fixture.example');
const discovery = source.slice(source.indexOf('local_path_belongs_to_account()'), source.indexOf('agent_exists()'));
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jetspace-project-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function run(code, cwd = dir) {
  const script = `set -euo pipefail
    API_KEY=fixture-key
    API_BASE=https://fixture.example/api
    CHATSPACE_DIR="$FIXTURE_HOME/project/.chatspace"
    LOCAL_CHIEFS_INDEX="$FIXTURE_HOME/.chatmcp/local-chief-paths"
    ${discovery.replaceAll('$HOME', '$FIXTURE_HOME')}
    ${code}`;
  const result = spawnSync('bash', ['-c', script], { cwd, env: { ...process.env, FIXTURE_HOME: dir }, encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout.trim();
}
function chief(location, name = 'General Chief of Staff', key = 'fixture-key') {
  const target = path.join(dir, location);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, '.env'), `AGENT_NAME="${name}"\nAPI_KEY="${key}"\nAPI_BASE="https://fixture.example/api"\nIS_CHIEF_OF_STAFF="true"\n`);
  return target;
}
test('dash-named Chief of Staff folders resolve by recorded name and stay discoverable from other projects', () => {
  const target = chief('project/.chatspace/general-chief-of-staff');
  expect(run('get_existing_agents')).toBe('General Chief of Staff');
  fs.mkdirSync(path.join(dir, 'other/.chatspace'), { recursive: true });
  expect(run('CHATSPACE_DIR="$FIXTURE_HOME/other/.chatspace"; get_existing_agents; resolve_agent_dir "General Chief of Staff"'))
    .toBe(`General Chief of Staff\n${target}`);
  expect(fs.statSync(path.join(dir, '.chatmcp/local-chief-paths')).mode & 0o077).toBe(0);
});
test('legacy global chiefs resolve without copying state and do not cross accounts or servers', () => {
  const target = chief('.chatmcp/.chatspace/general-chief-of-staff');
  expect(run('resolve_agent_dir "General Chief of Staff"')).toBe(target);
  expect(run('API_KEY=another-account; get_existing_agents')).toBe('');
  expect(run('API_BASE=https://other.example/api; get_existing_agents')).toBe('');
});
test('a registered chief launches the original runner and retains its original workspace', () => {
  const target = chief('original project/.chatspace/general-chief-of-staff');
  fs.writeFileSync(path.join(target, 'agent-runner.sh'), '#!/bin/bash\ncd "$(dirname "$0")/../.."\npwd\n', { mode: 0o700 });
  const foreground = source.match(/^start_agent_foreground\(\) \{[\s\S]*?^\}/m)[0];
  const output = run(`remember_local_chief "$FIXTURE_HOME/original project/.chatspace/general-chief-of-staff"
    agent_session_name() { printf fixture; }
    agent_is_running() { return 1; }
    ${foreground}
    start_agent_foreground 'General Chief of Staff' "$(resolve_agent_dir 'General Chief of Staff')"`);
  expect(output).toContain(path.join(dir, 'original project'));
});
test.each([true, false])('global launcher uses the caller project; local CLI keeps its own storage (global=%s)', global => {
  const install = global ? path.join(dir, '.chatmcp') : path.join(dir, 'installed project');
  const caller = path.join(dir, 'caller project');
  fs.mkdirSync(install, { recursive: true }); fs.mkdirSync(caller);
  const setup = source.slice(source.indexOf('SCRIPT_DIR="$(cd'), source.indexOf('# Colors for non-gum'));
  const script = path.join(install, 'agent-cli.sh');
  fs.writeFileSync(script, setup.replaceAll('$HOME', '$FIXTURE_HOME') + '\nprintf "%s\\n" "$CHATSPACE_DIR"\n');
  const result = spawnSync('bash', [script], { cwd: caller, env: { ...process.env, FIXTURE_HOME: dir }, encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(path.join(global ? caller : install, '.chatspace'));
});

test('standard agents created by older global jetspace versions remain reachable', () => {
  const target = chief('.chatmcp/.chatspace/legacy-agent', 'Legacy agent');
  const envFile = path.join(target, '.env');
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace('IS_CHIEF_OF_STAFF="true"', 'IS_CHIEF_OF_STAFF="false"'));
  expect(run('get_existing_agents; resolve_agent_dir "Legacy agent"')).toBe(`Legacy agent\n${target}`);
});
