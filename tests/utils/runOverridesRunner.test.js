const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateAgentRunner, generateMessageHelperPython } = require('../../src/utils/apiGuideGenerator');

function extractFunction(script, name) {
  const lines = script.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return lines.slice(start, end + 1).join('\n');
}

describe('per-message run overrides in the generated runner', () => {
  const runner = generateAgentRunner();

  it('passes bash -n and wires the overrides around run_agent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-syntax-'));
    try {
      const file = path.join(dir, 'runner.sh');
      fs.writeFileSync(file, runner);
      const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(runner).toContain('apply_run_overrides');
      expect(runner).toContain('restore_run_overrides');
      expect(runner.indexOf('apply_run_overrides; then')).toBeLessThan(runner.indexOf('run_agent "$prompt" || agent_rc=$?'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies overrides for one run and restores the agent config afterwards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-run-'));
    try {
      const harness = [
        '#!/bin/bash',
        'log() { :; }',
        'validate_config() { return "${VALIDATE_RC:-0}"; }',
        `RUN_OVERRIDES_FILE="${dir}/.run_overrides.json"`,
        'SAVED_RUN_CONFIG=()',
        'MODEL_PROVIDER=codex; MODEL=gpt-5.6-terra; APPROVAL_MODE=full-auto; SANDBOX_MODE=workspace-write; THINKING_EFFORT=""',
        extractFunction(runner, 'apply_run_overrides'),
        extractFunction(runner, 'restore_run_overrides'),
        `echo '{"model_provider":"claude","model":"claude-sonnet-5","thinking_effort":"high","sandbox_mode":"read-only"}' > "$RUN_OVERRIDES_FILE"`,
        'apply_run_overrides && echo "applied=$MODEL_PROVIDER/$MODEL/$APPROVAL_MODE/$SANDBOX_MODE/$THINKING_EFFORT"',
        '[ ! -f "$RUN_OVERRIDES_FILE" ] && echo consumed',
        'restore_run_overrides',
        'echo "restored=$MODEL_PROVIDER/$MODEL/$APPROVAL_MODE/$SANDBOX_MODE/[$THINKING_EFFORT]"',
        'apply_run_overrides || echo "none-without-file"',
        `echo '{"model_provider":"gemini","model":"x"}' > "$RUN_OVERRIDES_FILE"`,
        'VALIDATE_RC=1 apply_run_overrides || echo "rejected"',
        'echo "after-reject=$MODEL_PROVIDER/$MODEL"',
      ].join('\n');
      const file = path.join(dir, 'h.sh');
      fs.writeFileSync(file, harness);
      const result = spawnSync('bash', [file], { encoding: 'utf8' });
      expect(result.stdout.split('\n').filter(Boolean)).toEqual([
        'applied=claude/claude-sonnet-5/full-auto/read-only/high',
        'consumed',
        'restored=codex/gpt-5.6-terra/full-auto/workspace-write/[]',
        'none-without-file',
        'rejected',
        'after-reject=codex/gpt-5.6-terra',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('message helper persists and clears the overrides file', () => {
    const helper = generateMessageHelperPython();
    expect(helper).toContain('_RUN_OVERRIDES_FILE');
    expect(helper).toContain('_save_run_overrides(result)');
    expect(helper).toContain('.run_overrides.json');
  });

  it.each(['claude', 'codex', 'codex-cli', 'gemini', 'kilo', 'copilot', 'antigravity', 'pi', 'openai', 'openrouter', 'ollama', 'lmstudio'])('preserves complete shared JSON from %s and separates diagnostics', (provider) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-cli-output-'));
    try {
      const reply = { replies: Array.from({ length: 6 }, (_, i) => ({
        text: `Reply ${i}: sandbox and MCP server text belongs in the answer`,
        audience: { mode: 'owner' }, toUserIds: [], replyTo: [], kind: 'message', options: [], files: []
      })) };
      const output = JSON.stringify(reply, null, 2) + '\n';
      fs.writeFileSync(path.join(dir, 'fixture.json'), provider === 'claude' ? JSON.stringify({
        type: 'result', is_error: false, result: output.trimEnd(), session_id: 'fixture',
        progress: 'Intermediate tool progress must never become a chat reply', usage: { input_tokens: 123 }
      }) : output);
      const binary = provider === 'antigravity' ? 'agy' : ['codex-cli', 'openai', 'openrouter', 'ollama', 'lmstudio'].includes(provider) ? 'codex' : provider;
      fs.writeFileSync(path.join(dir, binary), '#!/bin/bash\n[ "$1" != "trust" ] || exit 0\n[ "$FIXTURE_PROVIDER" = "antigravity" ] || cat >/dev/null\nprintf "provider diagnostic\\n" >&2\ncat "$FIXTURE_OUTPUT"\n', { mode: 0o700 });
      const harness = [
        'log() { :; }', 'send_message() { :; }', 'send_error_message() { :; }',
        'should_send_command_preview() { return 1; }', 'send_working_heartbeat() { return 0; }',
        'check_stop_flag() { return 1; }', 'resolve_codex_bin() { command -v codex; }',
        'ensure_gemini_node_compat() { return 0; }', 'gemini_supports_explicit_model_selection() { return 0; }',
        'format_command_preview() { printf "%s " "$@"; }',
        'STATE_DIR="$TEST_DIR"; PROJECT_ROOT="$TEST_DIR"; SCRIPT_DIR="$TEST_DIR"',
        'AGENT_RESPONSE_FILE="$TEST_DIR/response.json"; AGENT_PID_FILE="$TEST_DIR/provider.pid"',
        'LAST_INTERRUPTED_OUTPUT_FILE="$TEST_DIR/interrupted.txt"; WORKING_HEARTBEAT_INTERVAL=10',
        'MODEL=fixture; APPROVAL_MODE=auto-edit; SANDBOX_MODE=workspace-write; THINKING_EFFORT=""',
        extractFunction(runner, 'run_cli_in_background'), extractFunction(runner, 'run_agent'),
        'run_agent "Return the complete shared JSON reply" >&2', 'cat "$AGENT_RESPONSE_FILE"'
      ].join('\n');
      const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_DIR: dir, MODEL_PROVIDER: provider,
          FIXTURE_OUTPUT: path.join(dir, 'fixture.json'), FIXTURE_PROVIDER: provider, CHATSPACE_SHARED_TURN: '1' } });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(output);
      expect(result.stderr).toContain('provider diagnostic');
      expect(JSON.parse(result.stdout)).toEqual(reply);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 15000);
});
