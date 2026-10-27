const { spawnSync } = require('child_process');
const { generateAgentRunner } = require('../../src/utils/apiGuideGenerator');
const source = generateAgentRunner();
const check = source.slice(source.indexOf('check_for_messages() {'), source.indexOf('get_history() {', source.indexOf('check_for_messages() {')));
test.each(['Please fix this error', 'usage: send task', 'unknown command from the parser', 'No problems found'])('passes valid DM text to the agent: %s', content => {
  const result = spawnSync('bash', ['-c', `
SCRIPT_DIR="$TMPDIR"
STATE_DIR="$TMPDIR/dm-runner-fixture-$$"
ALLOWED_PERMISSIONS='{"inter_agent":{"enabled":true}}'
uv() { if [ "$4" = check ]; then printf 'Received 1 message(s):\\n  [Peer]: %s\\n' "$DM_CONTENT"; else printf 'No new messages.'; fi; }
mark_successful_backend_connection() { :; }
${check}
check_for_messages
rm -rf "$STATE_DIR"
`], { encoding: 'utf8', env: { ...process.env, TMPDIR: require('os').tmpdir(), DM_CONTENT: content } });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('[AGENT DM]');
  expect(result.stdout).toContain(content);
});
test('ignores failed helper stdout while leaving server DMs pending', () => {
  const result = spawnSync('bash', ['-c', `
SCRIPT_DIR="$TMPDIR"; STATE_DIR="$TMPDIR/dm-runner-fixture-$$"; ALLOWED_PERMISSIONS='{"inter_agent":{"enabled":true}}'
uv() { if [ "$4" = check ]; then printf 'Unexpected failure'; return 1; else printf 'No new messages.'; fi; }
mark_successful_backend_connection() { :; }
${check}
check_for_messages
rm -rf "$STATE_DIR"
`], { encoding: 'utf8', env: { ...process.env, TMPDIR: require('os').tmpdir() } });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('No new messages.');
});
test.each([0, 1, 143])('all provider exit codes reach the inbox loop: %s', code => {
  const start = source.indexOf('    # All providers must report failure');
  const end = source.indexOf('    # Shared callers deliver', start);
  const result = spawnSync('bash', ['-c', `
log() { :; }
send_error_message() { :; }
provider_result() {
local cli_exit=${code}
${source.slice(start, end)}
return 0
}
provider_result
`], { encoding: 'utf8' });
  expect(result.status).toBe(code);
});
test.each([0, 1, 143])('only a successful turn confirms its DM batch: %s', code => {
  const start = source.indexOf('            if [ "$agent_rc" -eq 0 ]; then');
  const end = source.indexOf('\n            else', start);
  const result = spawnSync('bash', ['-c', `
agent_rc=${code}
uv() { printf 'ACK'; }
log() { :; }
${source.slice(start, end)}
fi
`], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(code === 0 ? 'ACK' : '');
});
