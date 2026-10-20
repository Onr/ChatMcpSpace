const { generateApiGuide, generateDirectSetupScript, generateMainCLIScript } = require('../../src/utils/apiGuideGenerator');

describe('generateApiGuide', () => {
  it('mentions the sanitized agent folder and CLI flow', () => {
    const markdown = generateApiGuide('KEY123', 'https://example.com', 'My Agent!', 'salt');
    expect(markdown).toContain('.chatspace/my_agent_/');
    expect(markdown).toMatch(/history/);
    expect(markdown).toMatch(/send/);
    expect(markdown).toMatch(/ask/);
    expect(markdown).toMatch(/ALL further conversation happens through these CLI commands/);
  });
});

describe('generateDirectSetupScript', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('embeds API values and encryption prompts when salt is provided', () => {
    const script = generateDirectSetupScript('K-123', 'https://api.example.com', 'Agent One!', 'abc123');
    expect(script).toContain('API_KEY="K-123"');
    expect(script).toContain('API_BASE="https://api.example.com/api"');
    expect(script).toContain('ENCRYPTION_SALT="abc123"');
    expect(script).toContain('.chatspace/agent_one_');
    expect(script).toContain('read -sp "Enter your account password');
    expect(script).toContain('cryptography.hazmat.primitives.ciphers.aead');
    expect(script).toContain('"encrypted": True');
  });

  it('omits password prompt and encryption plumbing when salt is missing', () => {
    const script = generateDirectSetupScript('K-456', 'http://localhost:3000', 'Agent Two!', null);
    expect(script).toContain('ENCRYPTION_SALT=""');
    expect(script).toContain('USER_PASSWORD=""');
    expect(script).toContain('.chatspace/agent_two_');
    expect(script).not.toContain('cryptography.hazmat.primitives.ciphers.aead');
    expect(script).toContain('"encrypted": False');
  });

  it('enforces encryption in production for direct setup generation', () => {
    process.env.NODE_ENV = 'production';
    expect(() => generateDirectSetupScript('K-789', 'https://api.example.com', 'Prod Agent', null))
      .toThrow(/ENCRYPTION_SALT is required in production/i);
  });
});

describe('encryption policy', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('enforces encryption in production for main CLI generation', () => {
    process.env.NODE_ENV = 'production';
    expect(() => generateMainCLIScript('TEST_KEY', 'https://example.com', null))
      .toThrow(/ENCRYPTION_SALT is required in production/i);
  });
});

describe('generateMainCLIScript - agent runner fixes', () => {
  let cliScript;
  let encryptedCliScript;

  beforeAll(() => {
    cliScript = generateMainCLIScript('TEST_KEY', 'https://example.com', null);
    encryptedCliScript = generateMainCLIScript('TEST_KEY', 'https://example.com', 'salt-for-tests');
  });

  describe('Local CoS bundle write-loop integrity guards', () => {
    it('rejects path-traversal / absolute bundle paths', () => {
      expect(cliScript).toContain('Skipping unsafe bundle path');
      expect(cliScript).toContain('/*|../*|*/../*|*/..|..');
    });

    it('clamps chmod modes to a safe octal allow-list', () => {
      expect(cliScript).toContain('600|644|700|755)');
      expect(cliScript).toContain('Refusing disallowed mode');
    });
  });

  describe('Local Chief of Staff persistent-mode setup', () => {
    it('offers opt-in systemd persistence during CoS installation', () => {
      expect(cliScript).toContain('Start this Chief of Staff automatically after reboot?');
      expect(cliScript).toContain('Enable persistence');
      expect(cliScript).toContain('sudo loginctl enable-linger $USER');
      expect(cliScript).toContain('enable_autostart "$agent_name"');
      expect(cliScript).toContain('falling back to the tmux launch option');
    });
  });

  describe('Run-command reporting (dashboard message info modal)', () => {
    it('exports RUN_COMMAND with the exact command in every provider branch', () => {
      const exportCount = (cliScript.match(/export RUN_COMMAND="\$cmd_preview"/g) || []).length;
      const previewBranchCount = (cliScript.match(/if should_send_command_preview; then/g) || []).length;
      expect(previewBranchCount).toBeGreaterThan(0);
      expect(exportCount).toBe(previewBranchCount);
    });

    it('clears stale RUN_COMMAND at the start of each agent run', () => {
      expect(cliScript).toContain('export RUN_COMMAND=""');
    });

    it('sends runCommand from the environment in message_helper send', () => {
      expect(cliScript).toContain('run_command = os.getenv("RUN_COMMAND", "")');
      expect(cliScript).toContain('payload["runCommand"] = run_command');
    });
  });

  describe('CoS .restart_requested handling', () => {
    it('defines RESTART_FLAG alongside STOP_FLAG', () => {
      expect(cliScript).toContain('RESTART_FLAG="$STATE_DIR/.restart_requested"');
    });

    it('defines check_restart_flag and handle_restart helpers', () => {
      expect(cliScript).toContain('check_restart_flag()');
      expect(cliScript).toContain('handle_restart()');
      // handle_restart must re-exec the runner with the original argv.
      expect(cliScript).toMatch(/exec "\$0" "\$\{RUNNER_ORIG_ARGS\[@\]\}"/);
    });

    it('captures original argv before parsing flags so re-exec keeps them', () => {
      expect(cliScript).toContain('RUNNER_ORIG_ARGS=("$@")');
      // The agent-runner has its own (later) parse-args block; the capture
      // must come before THAT block, not before the main CLI's parse-args.
      const captureIdx = cliScript.indexOf('RUNNER_ORIG_ARGS=("$@")');
      // Find the parse-args block that appears AFTER the capture.
      const runnerParseIdx = cliScript.indexOf(
        '# Parse command line arguments',
        captureIdx
      );
      expect(captureIdx).toBeGreaterThan(0);
      expect(runnerParseIdx).toBeGreaterThan(captureIdx);
    });

    it('main loop checks the restart flag and the idle wait wakes on it', () => {
      // The main loop must invoke check_restart_flag right next to check_stop_flag.
      expect(cliScript).toContain('if check_restart_flag; then');
      expect(cliScript).toContain('handle_restart');
      // The inner POLL_INTERVAL wait loop must also wake on a restart.
      expect(cliScript).toMatch(/Restart signal detected/);
    });
  });

  describe('runner restart and Claude effort settings', () => {
    it('preserves unread-message cursor on restart and forwards valid Claude effort', () => {
      expect(cliScript).toContain('preserving message cursor on startup');
      expect(cliScript).not.toContain('uv run message_helper.py sync > /dev/null 2>&1 || true');
      expect(cliScript).toContain('THINKING_EFFORT=""');
      expect(cliScript).toContain('claude_args+=("--effort" "$THINKING_EFFORT")');
    });
  });

  describe('Bug 1: DM check should only run when inter-agent is enabled', () => {
    it('guards dm check behind inter_agent.enabled check', () => {
      // The check_for_messages function should check ALLOWED_PERMISSIONS for inter_agent.enabled
      expect(cliScript).toContain('inter_agent_enabled');
      expect(cliScript).toContain('.inter_agent.enabled');
    });

    it('does not unconditionally call dm check', () => {
      // There should NOT be an unconditional dm check call outside the inter-agent guard
      const lines = cliScript.split('\n');
      const checkForMessagesStart = lines.findIndex(l => l.includes('check_for_messages()'));
      const checkForMessagesEnd = lines.findIndex((l, i) => i > checkForMessagesStart && l.trim() === '}');
      const functionBody = lines.slice(checkForMessagesStart, checkForMessagesEnd + 1).join('\n');

      // dm check should only appear inside the inter_agent_enabled guard
      const dmCheckLines = functionBody.split('\n').filter(l => l.includes('dm check'));
      expect(dmCheckLines.length).toBe(1); // exactly one dm check call

      // The dm check should be inside an if block checking inter_agent_enabled
      const dmCheckIndex = functionBody.indexOf('dm check');
      const guardIndex = functionBody.indexOf('inter_agent_enabled');
      expect(guardIndex).toBeLessThan(dmCheckIndex);
    });

    it('filters out error messages from dm check output', () => {
      expect(cliScript).toContain('error\\|not supported\\|unknown command\\|usage:');
    });
  });

  describe('Bug 2: Provider fallback when API returns disallowed provider', () => {
    it('falls back to first allowed provider when current is not allowed', () => {
      expect(cliScript).toContain('fallback_provider');
      expect(cliScript).toContain("Falling back to");
    });

    it('only sends config error once (not every poll)', () => {
      expect(cliScript).toContain('LAST_CONFIG_ERROR');
      expect(cliScript).toContain('error_key');
    });

    it('filters out inter_agent and project_path from provider list', () => {
      expect(cliScript).toContain('select(. != "inter_agent" and . != "project_path")');
    });
  });

  describe('Config error loop prevention', () => {
    it('adds duplicate-suppression and rate-limit controls for config errors', () => {
      expect(cliScript).toContain('CONFIG_ERROR_WINDOW_LIMIT=10');
      expect(cliScript).toContain('CONFIG_ERROR_WINDOW_SECONDS=60');
      expect(cliScript).toContain('CONFIG_ERROR_REPEAT_COOLDOWN=60');
      expect(cliScript).toContain('report_config_error()');
      expect(cliScript).toContain('send_error_message "$message" "$priority"');
      expect(cliScript).toContain('Duplicate config error suppressed');
      expect(cliScript).toContain('Config error notifications throttled');
    });

    it('auto-falls back to first allowed sandbox when current sandbox is disallowed', () => {
      expect(cliScript).toContain('fallback_sandbox');
      expect(cliScript).toContain("Falling back to '$fallback_sandbox'");
      expect(cliScript).toContain('SANDBOX_MODE="$normalized_fallback"');
    });
  });

  describe('Bug 3: Agent should not self-trigger on first init', () => {
    it('sleeps after sending introduction before entering poll loop', () => {
      const lines = cliScript.split('\n');
      const introSentIndex = lines.findIndex(l => l.includes('Introduction message sent'));
      const sleepAfterIntro = lines.findIndex((l, i) => i > introSentIndex && l.includes('sleep "$POLL_INTERVAL"'));
      const whileLoopIndex = lines.findIndex((l, i) => i > introSentIndex && l.includes('while [ -f "$RUNNING_FLAG" ]'));

      // Sleep should come BEFORE the while loop
      expect(sleepAfterIntro).toBeLessThan(whileLoopIndex);
    });

    it('has a comment explaining the sleep purpose', () => {
      expect(cliScript).toContain('Wait before first poll to avoid picking up our own intro');
    });

    it('does not silently drain the first real user message after intro', () => {
      expect(cliScript).not.toContain('Drain any messages that arrived during intro');
      expect(cliScript).not.toContain('check_for_messages > /dev/null 2>&1 || true');
    });
  });

  describe('Bug 4: Consecutive failure tracking prevents crash loops', () => {
    it('initializes CONSECUTIVE_FAILURES counter', () => {
      expect(cliScript).toContain('CONSECUTIVE_FAILURES=0');
    });

    it('increments failure counter on agent failure', () => {
      expect(cliScript).toContain('CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))');
    });

    it('pauses after 3 consecutive failures', () => {
      expect(cliScript).toContain('CONSECUTIVE_FAILURES -ge 3');
      expect(cliScript).toContain('sleep 60');
    });

    it('resets failure counter on success', () => {
      const success = cliScript.match(/if (run_agent "\$prompt"|\[ "\$agent_rc" -eq 0 \]); then\n([\s\S]*?)\n\s*else/);
      expect(success).not.toBeNull();
      const { spawnSync } = require('child_process');
      for (const [code, expected] of [[0, '0:1'], [3, '2:0']]) {
        const result = spawnSync('bash', ['-c', `CONSECUTIVE_FAILURES=2
run_success=0
agent_rc=${code}
prompt=fixture
run_agent() { return "$agent_rc"; }
if ${success[1]}; then
${success[2]}
fi
printf '%s:%s' "$CONSECUTIVE_FAILURES" "$run_success"`], { encoding: 'utf8', timeout: 5000 });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(expected);
      }
    });

    it('sends warning message after repeated failures', () => {
      expect(cliScript).toContain('Agent encountered repeated errors');
      expect(cliScript).toContain('send_error_message "⚠️ Agent encountered repeated errors');
    });
  });

  describe('Error spam circuit breaker', () => {
    it('tracks automated error volume and pauses recoverably at 30/hour', () => {
      expect(cliScript).toContain('ERROR_FAILSAFE_WINDOW_SECONDS=3600');
      expect(cliScript).toContain('ERROR_FAILSAFE_MAX_MESSAGES=30');
      expect(cliScript).toContain('record_error_event()');
      expect(cliScript).toContain('activate_error_failsafe_if_needed()');
      expect(cliScript).toContain('ERROR_COOLDOWN_SECONDS');
      expect(cliScript).toContain('Error circuit breaker activated');
      expect(cliScript).toContain('It will recover automatically');
      expect(cliScript).not.toContain('Agent stopped via error failsafe');
    });

    it('routes runtime missing-cli errors through send_error_message', () => {
      expect(cliScript).toContain('send_error_message "❌ Claude CLI is missing.');
      expect(cliScript).toContain('send_error_message "❌ Gemini CLI is missing.');
      expect(cliScript).toContain('send_error_message "❌ Codex CLI is missing.');
    });
  });

  describe('Runner resilience', () => {
    it('recovers from an unexpected runner-loop exit with bounded backoff', () => {
      expect(cliScript).toContain('supervise_main()');
      expect(cliScript).toContain('RUNNER_RESTART_MAX_ATTEMPTS');
      expect(cliScript).toContain('Runner loop exited unexpectedly');
    });

    it('keeps retrying slowly instead of terminating after a long backend outage', () => {
      expect(cliScript).toContain('continuing with slow recovery retries');
      expect(cliScript).toContain('if check_no_connection_failsafe; then');
      expect(cliScript).not.toContain('Agent stopped via no-connection failsafe');
    });

    it('uses durable systemd restart policy for any agent with autostart enabled', () => {
      expect(cliScript).toContain('Restart=always');
      expect(cliScript).toContain('RestartSec=5');
      expect(cliScript).toContain('StartLimitBurst=8');
    });
  });

  describe('Self wake and delayed tasks', () => {
    it('includes self-wake file handling in the runner', () => {
      expect(cliScript).toContain('SELF_WAKE_FILE="$STATE_DIR/.self_wakeup.txt"');
      expect(cliScript).toContain('consume_self_wakeup()');
      expect(cliScript).toContain('SELF WAKEUP:');
    });

    it('creates the self wake guide for new agents', () => {
      expect(cliScript).toContain('SELF_WAKE_GUIDE.md');
      expect(cliScript).toContain('Self-Wake & Delayed Tasks');
    });

    it('seeds scheduled tasks file for new agents', () => {
      expect(cliScript).toContain('agent_state/.scheduled_tasks.json');
      expect(cliScript).toContain("echo '[]' >");
    });

    it('defers scheduled/self wake until first user message arrives', () => {
      expect(cliScript).toContain('Skipping scheduled/self wake - waiting for first user message');
    });

    it('documents the self-wakeup trigger file example', () => {
      expect(cliScript).toContain('agent_state/.self_wakeup.txt');
      expect(cliScript).toContain('SELF WAKEUP: <file contents>');
    });
  });

  describe('Bug 5: Rich HTML fallback when agent cannot run shell commands', () => {
    it('prompt includes RICH_HTML_JSON fallback instructions', () => {
      expect(cliScript).toContain('RICH_HTML_JSON:');
      expect(cliScript).toContain('For fallback stdout mode');
      expect(cliScript).toContain('complete real rich_html JSON object');
    });

    it('stdout capture detects RICH_HTML_JSON marker in all provider sections', () => {
      // Count occurrences of RICH_HTML_JSON detection in stdout capture
      const matches = cliScript.match(/grep -o 'RICH_HTML_JSON:\.\*'/g);
      // Should be in Claude, Gemini, codex-cli, and default codex sections = 4
      expect(matches).not.toBeNull();
      expect(matches.length).toBeGreaterThanOrEqual(4);
    });

    it('response handler detects RICH_HTML_JSON in response file', () => {
      // The response file handler should also detect RICH_HTML_JSON
      expect(cliScript).toContain("rich_html_json=$(echo \"$response\" | grep -o 'RICH_HTML_JSON:.*'");
    });

    it('sends rich HTML JSON directly without priority parsing', () => {
      expect(cliScript).toContain('Detected rich HTML response');
      expect(cliScript).toContain('send_message "$rich_html_json"');
    });

    it('does not include copyable rich_html placeholder JSON in always-loaded instructions', () => {
      expect(cliScript).not.toContain('__REPLACE_WITH_TITLE__');
      expect(cliScript).not.toContain('__REPLACE_WITH_HTML__');
      expect(cliScript).not.toContain('"title":"REPLACE_WITH_TITLE"');
      expect(cliScript).not.toContain('"html":"REPLACE_WITH_HTML"');
      // Old verbatim placeholders that agents kept echoing back must not reappear
      expect(cliScript).not.toContain('"title":"My Report"');
      expect(cliScript).not.toContain('"html":"<div>Your HTML here</div>"');
      expect(cliScript).not.toContain('"title":"Your Title"');
    });

    it('does NOT wrap RICH_HTML_JSON in unescaped backticks inside the prompt heredoc', () => {
      // Regression: the prompt heredoc (`cat <<PROMPT ... PROMPT`) is UNQUOTED
      // so bash performs command substitution on any backtick pair. A line that
      // said: For fallback stdout mode, output `RICH_HTML_JSON:` followed by ...
      // made bash try to execute `RICH_HTML_JSON:` as a command, producing:
      //   ./agent-runner.sh: line NNNN: RICH_HTML_JSON:: command not found
      // The fix is to drop (or escape) the backticks around RICH_HTML_JSON in
      // that line. We assert the bad pattern cannot reappear.
      expect(cliScript).not.toContain('`RICH_HTML_JSON:`');
      // And the helpful phrasing is still present in some form.
      expect(cliScript).toContain('RICH_HTML_JSON:');
      expect(cliScript).toContain('For fallback stdout mode');
    });
  });

  describe('Bug: project_path config override must tolerate stale server paths', () => {
    // Regression: a Local Chief of Staff installed via the server was storing
    // the SERVER's path in runtime_config.project_path. When the user later
    // ran agent-runner.sh on their own machine, fetch_config_from_api returned
    // that path and load_config wrote it straight into PROJECT_ROOT, so the
    // next `cd "$PROJECT_ROOT"` (in run_agent_command) crashed with:
    //   ./agent-runner.sh: line NNNN: cd: /some/server/project: No such file or directory
    // and the spawned codex CLI itself reported "Error: No such file or
    // directory (os error 2)". The agent-runner must defend itself by only
    // honoring a configured project_path when the directory actually exists.
    it('only overrides PROJECT_ROOT when the configured path exists on this machine', () => {
      // Both halves of the guard must be present and on the same conditional.
      expect(cliScript).toMatch(
        /if \[ -n "\$new_project_path" \] && \[ -d "\$new_project_path" \]; then\s*\n\s*PROJECT_ROOT="\$new_project_path"/
      );
    });

    it('logs a warning when the configured project_path does not exist locally', () => {
      // The warning helps the user diagnose stale CoS config without needing
      // to read the bash source.
      expect(cliScript).toContain(
        "log WARN \"Configured project_path '$new_project_path' does not exist on this machine; keeping default '$PROJECT_ROOT'\""
      );
    });
  });

  describe('Attachment helper coverage', () => {
    it('documents generic file attachment support in the generated helper', () => {
      expect(encryptedCliScript).toContain('Upload encrypted file attachments');
      expect(encryptedCliScript).toContain('def upload_file(file_path: str');
      expect(encryptedCliScript).toContain('uv run message_helper.py upload <file-path>');
      expect(encryptedCliScript).toContain('send --attach - Upload and send a file in one command');
    });
  });

  describe('Agent reply vs news-feed instructions', () => {
    it('tells one-shot agents to reply to the user chat and not send only a news-feed entry', () => {
      expect(cliScript).toContain('If the latest actionable message is from the user, send a real reply to the user chat. Do not send only a news-feed entry.');
      expect(cliScript).toContain('Only skip the normal user-chat reply for fire-and-forget confirmation messages from another agent.');
    });

    it('keeps generated agent instructions explicit that news feed is secondary', () => {
      expect(cliScript).toContain('When a user asks for work, reply in the agent chat. Do not replace that reply with a news-feed post.');
      expect(cliScript).toContain('This is secondary to the normal agent chat reply. Use it only as an additional log entry:');
      expect(cliScript).toContain('The news feed does not replace a required user-facing reply in the agent chat.');
    });
  });

  describe('Bug 6: Gemini untrusted folder blocks all tool execution', () => {
    it('trusts project and agent folders before running Gemini', () => {
      expect(cliScript).toContain('gemini trust add "$PROJECT_ROOT"');
      expect(cliScript).toContain('gemini trust add "$SCRIPT_DIR"');
    });

    it('forces Gemini non-interactive mode using stdin redirect (-p -) to avoid interactive fallback', () => {
      expect(cliScript).toContain('run_cli_in_background "$prompt_file" "$stdout_capture" gemini "${gemini_args[@]}" -p -');
      expect(cliScript).toContain('cmd_preview=$(format_command_preview gemini "${gemini_args[@]}")');
      expect(cliScript).toMatch(/cmd_preview.*-p.*prompt/);
    });

    it('checks for a Node.js 20+ runtime before allowing Gemini setup or launch', () => {
      expect(cliScript).toContain('ensure_gemini_node_compat >/dev/null 2>&1');
      expect(cliScript).toContain('Gemini CLI requires Node.js 20 or newer');
      expect(cliScript).toContain('Detected runtime: `$current_node_version`');
    });

    it('only applies explicit Gemini model overrides when API-key or Vertex auth is available', () => {
      expect(cliScript).toContain('gemini_supports_explicit_model_selection()');
      expect(cliScript).toContain('GEMINI_API_KEY');
      expect(cliScript).toContain('GOOGLE_API_KEY');
      expect(cliScript).toContain('GOOGLE_GENAI_USE_VERTEXAI');
      expect(cliScript).toContain('Gemini model override');
      expect(cliScript).toContain("Falling back to Gemini's default model for this agent.");
    });

    it('searches common nvm locations for a compatible Node binary and prepends it to PATH', () => {
      expect(cliScript).toContain('find_compatible_node_bin()');
      expect(cliScript).toContain('get_node_major_version()');
      expect(cliScript).toContain('/.nvm/versions/node');
      expect(cliScript).toContain('export PATH="$compatible_dir:$PATH"');
      expect(cliScript).toContain('export GEMINI_NODE_BIN="$compatible_node"');
    });

    it('strips code blocks from Gemini stdout (unexecuted commands)', () => {
      // awk command that removes content between ``` markers
      expect(cliScript).toContain("awk '/^```/{skip=!skip; next} !skip{print}'");
    });

    it('filters Gemini-specific CLI noise from stdout', () => {
      expect(cliScript).toContain('Error executing tool');
      expect(cliScript).toContain('YOLO mode');
      expect(cliScript).toContain('Approval mode overridden');
      expect(cliScript).toContain('Loading extension');
    });
  });

  describe('Bug 7: Spawn flow must emit DM + frontend confirmation', () => {
    it('auto-sends child onboarding DM and parent frontend status message', () => {
      expect(cliScript).toContain('def _build_spawn_briefing');
      expect(cliScript).toContain('child["_briefingDmStatus"]');
      expect(cliScript).toContain('child["_briefingDmError"]');
      expect(cliScript).toContain('child["_frontendNotificationSent"]');
      expect(cliScript).toContain('child["_frontendNotificationError"]');
    });

    it('prints spawn DM/frontend status in CLI output and enforces spawn verification guidance', () => {
      expect(cliScript).toContain('Briefing DM:');
      expect(cliScript).toContain('Frontend notice:');
      expect(cliScript).toContain('verify output contains agentId');
    });

    it('supports project-path override and runtime metadata in spawn flow', () => {
      expect(cliScript).toContain('--project-path <dir>');
      expect(cliScript).toContain('payload["projectPath"] = project_path');
      expect(cliScript).toContain('Project path: ');
      expect(cliScript).toContain('sameMachineAsParent');
    });

    it('supports child group selection with same-group inheritance as the default', () => {
      expect(cliScript).toContain('--group <id-or-name>');
      expect(cliScript).toContain('--no-inherit-groups');
      expect(cliScript).toContain('payload["groups"] = groups');
      expect(cliScript).toContain("None inherits the parent's groups (recommended)");
    });
  });

  describe('Bug 10: Spawned agents must be stoppable from generated CLI', () => {
    it('adds stop controls to agent-cli.sh headless and interactive flows', () => {
      expect(cliScript).toContain('ARG_STOP=""');
      expect(cliScript).toContain('--stop <name>');
      expect(cliScript).toContain('stop_agent_control()');
      expect(cliScript).toContain('⏹️  Stop Running Agent');
      expect(cliScript).toContain('--create, --continue, --start, --restart, --shutdown, --status, --stop, --delete, --list, or --news-feed');
    });
  });

  describe('Local agent start/restart control and global launcher', () => {
    it('headless --continue preserves an existing agent config unless permission flags are passed', () => {
      expect(cliScript).toContain('run_agent_headless "$ARG_CONTINUE" preserve');
      expect(cliScript).toContain('if [ "$run_mode" = "preserve" ] && [ "$ARG_PERMS_EXPLICIT" != "true" ]');
      expect(cliScript).toMatch(/--allow-all\|--safe-defaults\|--setup-profile\|--providers/);
    });

    it('provides background start/restart/shutdown/status controls backed by one tmux session per agent', () => {
      for (const flag of ['--start <name>', '--restart <name>', '--shutdown <name>', '--status']) {
        expect(cliScript).toContain(flag);
      }
      expect(cliScript).toContain("printf '%s-local-agent'");
      expect(cliScript).toContain('tmux has-session -t "=$1"');
      // Supervisor loop restarts the runner after a crash, stops after a clean exit.
      expect(cliScript).toContain('[ "$code" -eq 0 ] && break');
    });

    it('detects orphaned runners/listeners and clears their lock on restart', () => {
      expect(cliScript).toContain('agent_runner_pids() {');
      expect(cliScript).toContain('pgrep -f "$agent_dir/agent_state/shared-runner.js"');
      // tmux servers can carry the runner command in argv; they must never be killed.
      expect(cliScript).toContain('in tmux*) continue ;; esac');
      expect(cliScript).toContain('rm -f "$agent_dir/agent_state/shared-agent.json.lock"');
    });

    it('runner removes a stale shared listener lock but refuses to double-start a live one', () => {
      expect(cliScript).toContain('sharing_lock="$STATE_DIR/shared-agent.json.lock"');
      expect(cliScript).toContain('ps -p "$lock_pid" -o args= 2>/dev/null | grep -q "shared-runner.js"');
      expect(cliScript).toContain('Removed stale shared listener lock');
    });

    it('never starts a second foreground runner while the background session is alive', () => {
      const fn = cliScript.slice(cliScript.indexOf('start_agent_foreground() {'));
      expect(fn.indexOf('agent_is_running "$agent_name"')).toBeLessThan(fn.indexOf('exec "$agent_dir/agent-runner.sh"'));
    });

    it('installs a global launcher wrapper that execs the CLI (no copied credentials)', () => {
      expect(cliScript).toContain('--install-command [cmd]');
      expect(cliScript).toContain('exec bash "$self_path" "\\$@"');
      expect(cliScript).toContain('# chatspace-launcher PATH');
    });

    it('adds message_helper stop command for agent-to-agent control', () => {
      expect(cliScript).toContain('def stop_agent(target_agent: str) -> dict:');
      expect(cliScript).toContain('uv run message_helper.py stop <agentName>');
      expect(cliScript).toContain('if command == "stop":');
      expect(cliScript).toContain('result = stop_agent(target)');
    });

    it('includes runner failsafe shutdown (without archiving) on repeated stop requests', () => {
      expect(cliScript).toContain('STOP_FAILSAFE_WINDOW_SECONDS=120');
      expect(cliScript).toContain('STOP_FAILSAFE_MAX_HITS=2');
      expect(cliScript).toContain('activate_stop_failsafe_if_needed()');
      // Failsafe should NOT call self-terminate (which archives the agent)
      expect(cliScript).toContain('Agent stopped via stop failsafe (not archived');
      expect(cliScript).not.toContain('self-terminate "Failsafe activated after repeated stop requests"');
    });

    it('acknowledges the backend stop latch and queues a stop-summary self wake', () => {
      expect(cliScript).toContain('acknowledge_stop_request()');
      expect(cliScript).toContain('$API_BASE/agent/stop/acknowledge');
      expect(cliScript).toContain('queue_stop_summary_wakeup()');
      expect(cliScript).toContain('STOP SUMMARY TASK:');
      expect(cliScript).toContain('Agent stopped, queued final stop-status reply');
      expect(cliScript).toContain('Failed to queue stop summary; sent fallback stopped message');
    });

    it('captures interrupted CLI output so the stop summary can report real progress', () => {
      expect(cliScript).toContain('LAST_INTERRUPTED_OUTPUT_FILE="$STATE_DIR/.last_interrupted_output"');
      expect(cliScript).toContain('capture_interrupted_output()');
      expect(cliScript).toContain('tail -n 40 "$capture_path" > "$LAST_INTERRUPTED_OUTPUT_FILE"');
      expect(cliScript).toContain('Last interrupted output:');
    });
  });

  describe('Bug 11: Headless defaults should match allowed providers and defaults', () => {
    it('defaults inter-agent communication to listen_all in generated CLI', () => {
      expect(cliScript).toContain('ARG_INTER_AGENT="listen_all"');
    });

    it('defaults codex sandbox permissions to workspace-write with danger-full-access as explicit opt-in', () => {
      expect(cliScript).toContain('ARG_CODEX_SANDBOX="workspace-write"');
      expect(cliScript).not.toContain('ARG_CODEX_SANDBOX="workspace-write,danger-full-access"');
    });

    it('writes headless config using snake_case runtime keys', () => {
      expect(cliScript).toContain('"model_provider": "$first_provider_name"');
      expect(cliScript).toContain('"approval_mode": "$initial_approval"');
      expect(cliScript).toContain('"sandbox_mode": "$initial_sandbox"');
      expect(cliScript).toContain('"project_path": "$ARG_PROJECT_PATH"');
      expect(cliScript).not.toContain('"approvalMode"');
      expect(cliScript).not.toContain('"sandboxMode"');
    });

    it('supports copilot permissions in headless provider parsing', () => {
      expect(cliScript).toContain('provider_json=\'\\"copilot\\":{\\"--allow-all\\":false,\\"--allow-all-tools\\":false,\\"--allow-all-paths\\":false}\'');
    });

    it('supports antigravity permissions in headless provider parsing', () => {
      expect(cliScript).toContain('ARG_ANTIGRAVITY_SANDBOX="workspace-write"');
      expect(cliScript).toContain('ARG_ANTIGRAVITY_SKIP_PERMS=false');
      expect(cliScript).toContain('\\"antigravity\\":{\\"--sandbox\\":$sandbox_json');
      expect(cliScript).toContain('\\"--dangerously-skip-permissions\\":$ARG_ANTIGRAVITY_SKIP_PERMS');
    });

    it('supports pi as a headless provider with simple enabled permissions', () => {
      expect(cliScript).toContain('pi (Pi CLI - direct, uses Pi auth/providers)');
      expect(cliScript).toContain('\\"pi\\":{\\"enabled\\":true}');
      expect(cliScript).toContain('npm install -g @mariozechner/pi-coding-agent');
    });

    it('derives sandbox mode for headless config from allowed permissions', () => {
      expect(cliScript).toContain('sandbox_modes_json=$(jq -r --arg p "$first_provider_headless"');
      expect(cliScript).toContain('initial_sandbox="workspace-write"');
      expect(cliScript).toContain('index("danger-full-access") != null');
      expect(cliScript).not.toContain('"sandbox_mode": "none"');
    });
  });

  describe('Model catalog sync hooks', () => {
    it('includes backend model sync and cached model fetch functions', () => {
      expect(cliScript).toContain('sync_models_to_backend()');
      expect(cliScript).toContain('fetch_backend_models_for_provider()');
      expect(cliScript).toContain('/agent/models/sync');
      expect(cliScript).toContain('/agent/models?provider=');
    });

    it('offers current GPT-6 and GPT-5.6 models while keeping the accessible Terra default', () => {
      expect(cliScript).toContain('default (Codex default - gpt-5.6-terra)');
      expect(cliScript).toContain('gpt-6-astra (GPT-6 Astra - requires eligible access)');
      expect(cliScript).toContain('gpt-6-sol (GPT-6 Sol - latest coding model)');
      expect(cliScript).toContain('gpt-6.1-sol (GPT-6.1 Sol - latest balanced model)');
      expect(cliScript).toContain('gpt-6-luna (GPT-6 Luna - fastest)');
      expect(cliScript).toContain('gpt-5.6-terra (GPT-5.6 Terra - verified default)');
      expect(cliScript).toContain('gpt-5.6-luna (GPT-5.6 Luna - fastest)');
      expect(cliScript).toContain('gpt-5.6-sol (GPT-5.6 Sol - requires eligible plan)');
      expect(cliScript).toContain('gpt-5.5 (GPT-5.5 - latest)');
      expect(cliScript).toContain('gpt-5.5-pro (GPT-5.5 Pro - highest reasoning)');
      expect(cliScript).toContain('gpt-5.4 (GPT-5.4 - latest default)');
      expect(cliScript).toContain('gpt-5.4-pro (GPT-5.4 Pro - highest reasoning)');
      expect(cliScript).toContain('gpt-5.4-mini (GPT-5.4 Mini - efficient)');
      expect(cliScript).toContain('gpt-5.4-nano (GPT-5.4 Nano - lowest cost)');
      expect(cliScript).toContain('default|codex)');
      expect(cliScript).toContain('[ "$MODEL" != "default" ]');
      expect(cliScript).not.toContain('default (Codex default - gpt-5.4)');
    });

    it('forwards supported reasoning effort to Codex-backed GPT-6 Astra runs', () => {
      expect(cliScript).toContain("model_reasoning_effort='$THINKING_EFFORT'");
      expect(cliScript).toContain('low|medium|high|xhigh|max)');
      expect(cliScript).toContain('Ignoring unsupported Codex thinking_effort');
    });

    it('offers current Claude and Copilot fallback model choices', () => {
      expect(cliScript).toContain('claude-fable-5-1 (Claude Fable 5.1 - most capable)');
      expect(cliScript).toContain('claude-mythos-5-1 (Claude Mythos 5.1 - invite only)');
      expect(cliScript).toContain('claude-opus-5-5 (Claude Opus 5.5 - latest coding model)');
      expect(cliScript).toContain('claude-fable-5 (Claude Fable 5)');
      expect(cliScript).toContain('claude-mythos-5 (Claude Mythos 5 - invite only)');
      expect(cliScript).toContain('claude-sonnet-5-5 (Claude Sonnet 5.5 - latest balanced)');
      expect(cliScript).toContain('claude-sonnet-5 (Claude Sonnet 5)');
      expect(cliScript).toContain('claude-opus-4-8 (Claude Opus 4.8)');
      expect(cliScript).toContain('claude-opus-4-7 (Claude Opus 4.7 - latest)');
      expect(cliScript).toContain('claude-sonnet-4-6 (Claude Sonnet 4.6 - balanced)');
      expect(cliScript).toContain('claude-opus-4.8 (Claude Opus 4.8)');
      expect(cliScript).toContain('claude-opus-4.7 (Claude Opus 4.7)');
      expect(cliScript).toContain('gpt-5.4-mini (GPT 5.4 Mini)');
      expect(cliScript).toContain('gpt-5.3-codex (GPT 5.3 Codex)');
      expect(cliScript).toContain('gemini-3.8-flash (Gemini 3.8 Flash)');
    });

    it('offers Antigravity provider/model choices and runs agy in print mode', () => {
      expect(cliScript).toContain('antigravity (Antigravity CLI - direct, uses agy -p)');
      expect(cliScript).toContain('Select Antigravity model:');
      expect(cliScript).toContain('gemini-4-argon (Gemini 4 Argon)');
      expect(cliScript).toContain('claude-opus-5-5 (Claude Opus 5.5)');
      expect(cliScript).toContain('gemini-3.8-flash (Gemini 3.8 Flash)');
      expect(cliScript).toContain('prompt_text=$(cat "$prompt_file")');
      expect(cliScript).toContain('agy models');
      expect(cliScript).toContain("command('agy', ['models'])");
      expect(cliScript).toContain("local agy_tab=$'\\t'");
      expect(cliScript).toContain('local agy_model="${MODEL%%"$agy_tab"*}"');
      expect(cliScript).toContain('agy_args+=("--model" "$agy_model")');
      expect(cliScript).toContain('agy_args+=("--effort" "$THINKING_EFFORT")');
      expect(cliScript).toContain('agy_args+=("-p" "$prompt_text")');
      expect(cliScript).toContain('cmd_preview+=" <prompt_text>"');
      expect(cliScript).toContain('run_cli_in_background "" "$stdout_capture" agy "${agy_args[@]}"');
      expect(cliScript).toContain('Antigravity CLI is missing');
    });

    it('offers Pi model choices and runs Pi in print mode', () => {
      expect(cliScript).toContain('Select Pi model:');
      expect(cliScript).toContain('sonnet:high (Claude Sonnet with high thinking)');
      expect(cliScript).toContain('pi_args+=("-p" "Follow the instructions provided on stdin.")');
      expect(cliScript).toContain('run_cli_in_background "$prompt_file" "$stdout_capture" pi "${pi_args[@]}"');
      expect(cliScript).toContain('Pi CLI is missing. Please install it with: `npm install -g @mariozechner/pi-coding-agent`');
    });
  });

  describe('Bug 9: Uploaded images must be attached to outgoing message', () => {
    it('runner send_message includes pending attachments automatically', () => {
      expect(cliScript).toContain('--use-pending-attachments');
      expect(cliScript).toContain('output=$(uv run message_helper.py send "$message" --priority "$priority" --use-pending-attachments');
    });

    it('helper supports staged attachments and explicit attachment ids', () => {
      expect(encryptedCliScript).toContain('def _consume_pending_attachment_ids()');
      expect(encryptedCliScript).toContain('--attachment-id');
      expect(encryptedCliScript).toContain('Staged for next send: yes');
    });
  });

  describe('Agent send retry handling', () => {
    it('retries rate-limited sends before giving up', () => {
      expect(cliScript).toContain('local max_attempts=4');
      expect(cliScript).toContain('RATE_LIMIT_EXCEEDED');
      expect(cliScript).toContain('Rate limited while sending message');
      expect(cliScript).toContain('sleep "$retry_after"');
      expect(cliScript).toContain('Failed to send message after $attempt attempt(s)');
    });

    it('parses retryAfter from helper output when available', () => {
      expect(cliScript).toContain(`grep -oE "'retryAfter': [0-9]+"`);
      expect(cliScript).toContain(`grep -oE '"retryAfter"[[:space:]]*:[[:space:]]*[0-9]+'`);
    });
  });

  describe('Bug 12: Wake loop should react quickly to signal files', () => {
    it('checks wake signals in 1-second increments', () => {
      expect(cliScript).toContain('sleep 1');
      expect(cliScript).toContain('waited=$((waited + 1))');
    });
  });

  describe('Bug 8: Headless create must embed generated files, not placeholders', () => {
    it('does not leave literal template placeholders in created agent files', () => {
      expect(cliScript).not.toContain('$messageHelperPython');
      expect(cliScript).not.toContain('$agentInstructions');
      expect(cliScript).not.toContain('$oneshotInstructions');
      expect(cliScript).not.toContain('$richFormSkill');
      expect(cliScript).not.toContain('$agentRunner');
      expect(cliScript).toContain('message_helper.py - Agent messaging helper functions');
      expect(cliScript).toContain('# One-Shot Agent Instructions');
    });
  });

  describe('Bug: grep must not interpret --flag patterns as options', () => {
    it('uses -- before patterns starting with dashes in grep commands', () => {
      // grep -A 20 "--model <model>" causes grep to interpret --model as an option.
      // Must use grep -A 20 -- "--model <model>" to end option parsing first.
      const grepModelLines = cliScript.split('\n').filter(l => l.includes('grep') && l.includes('--model <model>'));
      for (const line of grepModelLines) {
        expect(line).toMatch(/grep\s+-A\s+\d+\s+--\s+"/);
      }
    });

    it('encrypted script also uses -- before dash patterns in grep', () => {
      const grepModelLines = encryptedCliScript.split('\n').filter(l => l.includes('grep') && l.includes('--model <model>'));
      for (const line of grepModelLines) {
        expect(line).toMatch(/grep\s+-A\s+\d+\s+--\s+"/);
      }
    });
  });

  describe('Dependency checks (jq and other required tools)', () => {
    it('refreshes common user-local tool paths before prerequisite checks', () => {
      expect(cliScript).toContain('refresh_common_tool_paths() {');
      expect(cliScript).toContain('export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$PATH"');
      expect(cliScript).toContain('check_prerequisites() {');
      expect(cliScript).toContain('refresh_common_tool_paths\n\n    local missing=()');
    });

    it('checks for jq in check_prerequisites', () => {
      // jq is used throughout the script for JSON parsing; must be caught early
      expect(cliScript).toContain('command -v jq');
      expect(cliScript).toContain('missing+=("jq")');
    });

    it('offers jq auto-install with package manager detection', () => {
      expect(cliScript).toContain('Do you want to install jq now?');
      expect(cliScript).toContain('apt-get install -y jq');
      expect(cliScript).toContain('brew install jq');
    });

    it('shows jq download URL when auto-install is declined', () => {
      expect(cliScript).toContain('jqlang.github.io/jq/download');
    });

    it('encrypted script also checks for jq', () => {
      expect(encryptedCliScript).toContain('missing+=("jq")');
    });
  });

  describe('Silent exit prevention', () => {
    it('includes ERR trap for diagnostic output', () => {
      expect(cliScript).toContain("trap 'echo");
      expect(cliScript).toContain('ERR');
    });

    it('runs auto_sync_all_installed_providers_models in background at entry point', () => {
      const entryPointSection = cliScript.split('# Entry Point')[1] || '';
      // Must be launched in background subshell so CLI startup never blocks
      expect(entryPointSection).toMatch(/auto_sync_all_installed_providers_models\s*\)\s*[^&\n]*&/);
      // Must NOT call it synchronously with || true
      expect(entryPointSection).not.toContain('auto_sync_all_installed_providers_models || true');
    });

    it('offers gum auto-install instead of just showing URL', () => {
      expect(cliScript).toContain('Do you want to install gum now?');
    });

    it('encrypted script also includes ERR trap', () => {
      expect(encryptedCliScript).toContain("trap 'echo");
      expect(encryptedCliScript).toContain('ERR');
    });

    it('encrypted script also runs auto_sync in background at entry point', () => {
      const entryPointSection = encryptedCliScript.split('# Entry Point')[1] || '';
      expect(entryPointSection).toMatch(/auto_sync_all_installed_providers_models\s*\)\s*[^&\n]*&/);
      expect(entryPointSection).not.toContain('auto_sync_all_installed_providers_models || true');
    });
  });

  describe('Agent runner startup resilience', () => {
    function getRunnerSlice(script) {
      const marker = '# Agent Runner - One-shot agent supervisor with dynamic config and stop support';
      const start = script.indexOf(marker);
      return start >= 0 ? script.slice(start) : '';
    }

    it('runner startup auto-sync runs in background and does not block startup', () => {
      const runnerSlice = getRunnerSlice(cliScript);
      // Must run in background (& at end) so it never blocks the agent startup
      expect(runnerSlice).toMatch(/auto_sync_all_installed_providers_models\s*\)\s*[^&]*&/);
      // Must NOT be called synchronously with || true in the runner main()
      const mainFnMatch = runnerSlice.match(/^main\(\)\s*\{([\s\S]*?)^\}/m);
      const mainBody = mainFnMatch ? mainFnMatch[1] : runnerSlice;
      expect(mainBody).not.toMatch(/auto_sync_all_installed_providers_models\s*\|\|\s*true\s*\n/);
    });

    it('auto_sync function itself is still non-fatal (returns 0)', () => {
      const runnerSlice = getRunnerSlice(cliScript);
      const autoSyncMatch = runnerSlice.match(/auto_sync_all_installed_providers_models\(\)\s*\{([\s\S]*?)\n\}/);
      const autoSyncBody = autoSyncMatch ? autoSyncMatch[1] : '';
      expect(autoSyncBody).toContain('return 0');
    });
  });

  describe('No-connection failsafe (48-hour)', () => {
    it('initializes LAST_SUCCESSFUL_CONNECTION at startup', () => {
      expect(cliScript).toContain('LAST_SUCCESSFUL_CONNECTION=$(date +%s)');
    });

    it('re-baselines the persisted connection timestamp when the runner starts', () => {
      const lines = cliScript.split('\n');
      const runningFlagLine = lines.findIndex(l => l.includes('echo $$ > "$RUNNING_FLAG"'));
      const markLine = lines.findIndex((l, i) => i > runningFlagLine && l.includes('mark_successful_backend_connection'));
      const historyLine = lines.findIndex((l, i) => i > runningFlagLine && l.includes('history=$(get_history)'));

      expect(runningFlagLine).toBeGreaterThan(-1);
      expect(markLine).toBeGreaterThan(runningFlagLine);
      expect(historyLine).toBeGreaterThan(markLine);
    });

    it('defines NO_CONNECTION_FAILSAFE_SECONDS as 172800 (48 hours)', () => {
      expect(cliScript).toContain('NO_CONNECTION_FAILSAFE_SECONDS=172800');
    });

    it('includes check_no_connection_failsafe function', () => {
      expect(cliScript).toContain('check_no_connection_failsafe()');
    });

    it('uses slow recovery retries rather than stopping after 48h without connection', () => {
      expect(cliScript).toContain('continuing with slow recovery retries');
      expect(cliScript).toContain('sleep 60');
      expect(cliScript).not.toContain('Agent stopped via no-connection failsafe');
    });

    it('updates LAST_SUCCESSFUL_CONNECTION on successful check-attachments exit', () => {
      // The check_for_messages function captures exit code and updates timestamp on success
      const lines = cliScript.split('\n');
      const checkFnStart = lines.findIndex(l => l.includes('check_for_messages()'));
      const checkFnEnd = lines.findIndex((l, i) => i > checkFnStart && l.trim() === '}');
      const fnBody = lines.slice(checkFnStart, checkFnEnd + 1).join('\n');
      expect(cliScript).toContain('mark_successful_backend_connection()');
      expect(fnBody).toContain('mark_successful_backend_connection');
      expect(fnBody).toContain('check_exit=$?');
    });

    it('persists successful connection timestamp outside command substitution subshells', () => {
      expect(cliScript).toContain('LAST_SUCCESSFUL_CONNECTION_FILE="$STATE_DIR/.last_successful_connection"');
      expect(cliScript).toMatch(/mark_successful_backend_connection\(\)[\s\S]*>\s*"\$LAST_SUCCESSFUL_CONNECTION_FILE"/);
      expect(cliScript).toContain('get_last_successful_backend_connection()');
      expect(cliScript).toMatch(/check_no_connection_failsafe\(\)[\s\S]*LAST_SUCCESSFUL_CONNECTION=\$\(get_last_successful_backend_connection\)/);
    });

    it('updates LAST_SUCCESSFUL_CONNECTION on successful history and send commands', () => {
      expect(cliScript).toMatch(/get_history\(\)[\s\S]*mark_successful_backend_connection/);
      expect(cliScript).toMatch(/send_message\(\)[\s\S]*mark_successful_backend_connection/);
    });

    it('calls check_no_connection_failsafe in the main polling loop after check_for_messages', () => {
      const lines = cliScript.split('\n');
      const checkResultLine = lines.findIndex(l => l.includes('check_result=$(check_for_messages)'));
      const failsafeCallLine = lines.findIndex(
        (l, i) => i > checkResultLine && l.includes('check_no_connection_failsafe')
      );
      const hasNewMsgsLine = lines.findIndex(
        (l, i) => i > checkResultLine && l.includes('has_new_messages "$check_result"')
      );
      // failsafe call must appear between check_for_messages and has_new_messages
      expect(failsafeCallLine).toBeGreaterThan(checkResultLine);
      expect(failsafeCallLine).toBeLessThan(hasNewMsgsLine);
    });
  });

  describe('No-connection give-up (7-day)', () => {
    it('defines NO_CONNECTION_GIVE_UP_SECONDS as 604800 (7 days)', () => {
      expect(cliScript).toContain('NO_CONNECTION_GIVE_UP_SECONDS=604800');
    });

    it('includes check_no_connection_giveup function', () => {
      expect(cliScript).toContain('check_no_connection_giveup()');
    });

    it('stops attempting to reach the backend after 7 days, unlike the 48h slow-retry', () => {
      expect(cliScript).toContain('giving up automated retries');
      expect(cliScript).not.toContain('Agent stopped via no-connection failsafe');
    });

    it('calls check_no_connection_giveup before check_for_messages, skipping the network call', () => {
      const lines = cliScript.split('\n');
      const giveupCallLine = lines.findIndex(l => l.includes('check_no_connection_giveup'));
      const checkResultLine = lines.findIndex(
        (l, i) => i > giveupCallLine && l.includes('check_result=$(check_for_messages)')
      );
      expect(giveupCallLine).toBeGreaterThan(-1);
      expect(checkResultLine).toBeGreaterThan(giveupCallLine);
    });

    it('re-baselines LAST_SUCCESSFUL_CONNECTION on startup so a restart resumes retrying', () => {
      // Same startup mark used by the 48h failsafe also un-sticks the 7-day give-up state.
      const lines = cliScript.split('\n');
      const runningFlagLine = lines.findIndex(l => l.includes('echo $$ > "$RUNNING_FLAG"'));
      const markLine = lines.findIndex((l, i) => i > runningFlagLine && l.includes('mark_successful_backend_connection'));
      expect(markLine).toBeGreaterThan(runningFlagLine);
    });
  });

  describe('Network timeout safety', () => {
    // Extract auto_sync function body from each script variant
    function extractAutoSyncBody(script) {
      const match = script.match(/auto_sync_all_installed_providers_models\(\)\s*\{([\s\S]*?)\n\}/);
      return match ? match[1] : '';
    }

    function extractSyncModelsBody(script) {
      const match = script.match(/sync_models_to_backend\(\)\s*\{([\s\S]*?)\n\}/);
      return match ? match[1] : '';
    }

    for (const [label, getScript] of [
      ['non-encrypted', () => cliScript],
      ['encrypted', () => encryptedCliScript],
    ]) {
      describe(`${label} script`, () => {
        it('metadata discovery bounds network requests and subprocess execution', () => {
          const script = getScript();
          expect(script).toContain('signal: AbortSignal.timeout(15000)');
          expect(script).toContain('timeout: 15000, maxBuffer:');
          expect(script).toContain('Model metadata timed out');
        });

        it('all curl calls in auto_sync have --max-time', () => {
          const body = extractAutoSyncBody(getScript());
          const curlLines = body.split('\n').filter(l => l.includes('curl '));
          for (const line of curlLines) {
            expect(line).toContain('--max-time');
          }
        });

        it('CLI tool calls (copilot, kilo) in auto_sync are wrapped with timeout', () => {
          const body = extractAutoSyncBody(getScript());
          const copilotLine = body.split('\n').find(l => l.includes('copilot --help'));
          const kiloLine = body.split('\n').find(l => l.includes('kilo models'));
          if (copilotLine) expect(copilotLine).toMatch(/timeout\s+\d+\s+copilot/);
          if (kiloLine) expect(kiloLine).toMatch(/timeout\s+\d+\s+kilo/);
        });

        it('sync_models_to_backend curl has --connect-timeout and --max-time', () => {
          const body = extractSyncModelsBody(getScript());
          const curlLines = body.split('\n').filter(l => l.includes('curl '));
          expect(curlLines.length).toBeGreaterThan(0);
          for (const line of curlLines) {
            expect(line).toContain('--connect-timeout');
            expect(line).toContain('--max-time');
          }
        });
      });
    }
  });

  describe('Bug: create_provider_instructions must not break bash quoting', () => {
    // Regression: the provider_content="..." form embedded a JSON example
    // whose unescaped " characters terminated the bash double-quoted string
    // early. The first whitespace after that point made bash treat the next
    // word as a command — the user hit "agent-cli.sh: line 8732: task: command not found"
    // because "Brief task summary here" got split into tokens.

    it('uses a quoted heredoc for provider_content (not a "..." string)', () => {
      // The fix is to embed the markdown via <<'PROVIDEREOF' so " characters
      // are literal. If someone reintroduces the "..." form, this catches it.
      expect(cliScript).toContain("provider_content=$(cat <<'PROVIDEREOF'");
      expect(cliScript).toContain('PROVIDEREOF\n)');
      expect(cliScript).not.toMatch(/provider_content="# Agent Instructions for/);
    });

    it('uses placeholder substitution for provider name/cli (not direct $var)', () => {
      // Quoted heredocs do not expand variables; the provider must be
      // inserted via sed placeholder substitution.
      expect(cliScript).toContain('__PROVIDER_NAME__');
      expect(cliScript).toContain('__PROVIDER_CLI__');
      expect(cliScript).toMatch(/sed[^\n]*s\|__PROVIDER_NAME__\|\$pname\|g/);
      expect(cliScript).toMatch(/sed[^\n]*s\|__PROVIDER_CLI__\|\$pcli\|g/);
    });

    it('runs create_provider_instructions successfully against a temp dir', () => {
      // End-to-end execution test: extract create_provider_instructions,
      // stub its dependencies, and run it. Catches future regressions where
      // bash quoting breaks even if the literal text changes.
      const tmp = require('os').tmpdir();
      const fs = require('fs');
      const path = require('path');
      const { spawnSync } = require('child_process');

      const workdir = fs.mkdtempSync(path.join(tmp, 'provider-instr-test-'));
      try {
        // Pull just the function body out of the generated script.
        const lines = cliScript.split('\n');
        const startIdx = lines.findIndex((l) => l.startsWith('create_provider_instructions()'));
        expect(startIdx).toBeGreaterThan(-1);
        // Find the matching closing brace at the start of a line.
        let endIdx = -1;
        for (let i = startIdx + 1; i < lines.length; i++) {
          if (lines[i] === '}') { endIdx = i; break; }
        }
        expect(endIdx).toBeGreaterThan(startIdx);
        const fnBody = lines.slice(startIdx, endIdx + 1).join('\n');

        const harness = [
          '#!/bin/bash',
          'set -e',
          'print_section() { echo ">>> $*"; }',
          'print_success() { echo "    [ok] $*"; }',
          'print_warning() { echo "    [warn] $*"; }',
          'print_info() { echo "    [info] $*"; }',
          'print_error() { echo "    [err] $*"; }',
          'get_agent_folder() { echo "local_news_-_test"; }',
          `SCRIPT_DIR="${workdir}"`,
          'cd "$SCRIPT_DIR"',
          fnBody,
          '',
          'create_provider_instructions "Local News Feed"',
        ].join('\n');

        const harnessPath = path.join(workdir, 'harness.sh');
        fs.writeFileSync(harnessPath, harness);

        const result = spawnSync('bash', [harnessPath], { encoding: 'utf8' });
        expect(result.status).toBe(0);
        expect(result.stderr).not.toMatch(/command not found/);
        expect(result.stderr).not.toMatch(/task:/);

        // All three provider files should be created with substituted content.
        const agents = fs.readFileSync(path.join(workdir, 'AGENTS.md'), 'utf8');
        expect(agents).toContain('# Agent Instructions for Codex');
        expect(agents).not.toContain('__PROVIDER_NAME__');
        expect(agents).not.toContain('__PROVIDER_CLI__');
        expect(agents).not.toContain('__SCRIPT_DIR__');
        expect(agents).not.toContain('__NEWS_FEED_FOLDER__');

        const claude = fs.readFileSync(path.join(workdir, 'CLAUDE.md'), 'utf8');
        expect(claude).toContain('# Agent Instructions for Claude');
        expect(claude).not.toContain('__PROVIDER_NAME__');

        const gemini = fs.readFileSync(path.join(workdir, 'GEMINI.md'), 'utf8');
        expect(gemini).toContain('# Agent Instructions for Gemini');
        expect(gemini).not.toContain('__PROVIDER_NAME__');
      } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
      }
    });
  });

  describe('Generated CLI script: bash syntax validation', () => {
    // Catch quoting / heredoc bugs at parse time (e.g. unclosed strings).
    // Won't catch the specific "task" bug above (that's a runtime issue
    // where bash succeeds at parse but mis-tokenises the value) — that
    // is covered by the runtime test in the previous describe block.
    it('passes `bash -n` syntax check (unencrypted variant)', () => {
      const tmp = require('os').tmpdir();
      const fs = require('fs');
      const path = require('path');
      const { spawnSync } = require('child_process');

      const tmpfile = path.join(tmp, `agent-cli-syntax-test-${process.pid}.sh`);
      fs.writeFileSync(tmpfile, cliScript);
      try {
        const result = spawnSync('bash', ['-n', tmpfile], { encoding: 'utf8' });
        if (result.status !== 0) {
          // Helpful error message when this regresses.
          throw new Error(`bash -n failed:\n${result.stderr}`);
        }
        expect(result.status).toBe(0);
      } finally {
        fs.rmSync(tmpfile, { force: true });
      }
    });

    it('passes `bash -n` syntax check (encrypted variant)', () => {
      const tmp = require('os').tmpdir();
      const fs = require('fs');
      const path = require('path');
      const { spawnSync } = require('child_process');

      const tmpfile = path.join(tmp, `agent-cli-syntax-test-enc-${process.pid}.sh`);
      fs.writeFileSync(tmpfile, encryptedCliScript);
      try {
        const result = spawnSync('bash', ['-n', tmpfile], { encoding: 'utf8' });
        if (result.status !== 0) {
          throw new Error(`bash -n failed:\n${result.stderr}`);
        }
        expect(result.status).toBe(0);
      } finally {
        fs.rmSync(tmpfile, { force: true });
      }
    });
  });
});

describe('generateMainCLIScript - agent creation defaults', () => {
  it('uses the local computer and current folder for the editable agent-name default', () => {
    const cliScript = generateMainCLIScript('TEST_KEY', 'https://example.com', null);

    expect(cliScript).toContain('computer_name="$(hostname -s');
    expect(cliScript).toContain('project_name="$(basename "$PWD"');
    expect(cliScript).toContain('default_agent_name="${computer_name}-${project_name}"');
    expect(cliScript).toContain('default_agent_name="$project_name"');
  });
});

test.each(['unavailable', 'invalid'])('native startup retries %s sharing availability without selecting the private-only loop', (kind) => {
  const { generateAgentRunner } = require('../../src/utils/apiGuideGenerator');
  const source = generateAgentRunner();
  const start = source.indexOf('if [ "${CHATSPACE_TRUSTED_SHARING:-1}"');
  const end = source.indexOf('\n    if [ "$(printf', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const stub = kind === 'unavailable' ? 'curl() { return 22; }' : "curl() { printf '<html>temporarily unavailable</html>'; }";
  const result = require('child_process').spawnSync('bash', ['-c', `${stub}\nlog() { printf '%s\\n' "$*" >&2; }\n${source.slice(start, end)}\nfi\nprintf 'PRIVATE_LOOP'`], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('supervisor will retry');
  expect(result.stdout).not.toContain('PRIVATE_LOOP');
});

test('headless session commands use an enabled persistent service instead of starting a second listener', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-agent-cli-'));
  try {
    const agentDir = path.join(dir, 'fixture'); fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, '.env'), ''); fs.writeFileSync(path.join(agentDir, 'agent-runner.sh'), '#!/bin/bash\n', { mode: 0o700 });
    const source = generateMainCLIScript('fixture', 'https://example.invalid');
    const start = source.indexOf('start_agent_session() {'), end = source.indexOf('show_agent_session_status() {', start);
    const harness = `CHATSPACE_DIR="$1"\nget_agent_folder() { printf fixture; }\nagent_session_name() { printf fixture-local-agent; }\nsystemctl() { if [ "$2" = "is-enabled" ]; then return 0; fi; printf 'SERVICE:%s:%s\\n' "$2" "$3"; }\ntmux() { printf 'UNEXPECTED_TMUX'; return 1; }\n${source.slice(start, end)}\nstart_agent_session Fixture start\nstart_agent_session Fixture restart\nshutdown_agent_session Fixture`;
    const result = require('child_process').spawnSync('bash', ['-c', harness, 'fixture', dir], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SERVICE:start:agent-fixture.service');
    expect(result.stdout).toContain('SERVICE:restart:agent-fixture.service');
    expect(result.stdout).toContain('SERVICE:stop:agent-fixture.service');
    expect(result.stdout).not.toContain('UNEXPECTED_TMUX');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
