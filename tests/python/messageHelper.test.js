const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateDirectSetupScript } = require('../../src/utils/apiGuideGenerator');

jest.setTimeout(20000);

const baseSalt = Buffer.from('test-salt').toString('base64');

function extractHelperCode(script) {
  const match = script.match(/message_helper\.py"\s*<<'([A-Z_]+)'/);
  if (!match) {
    throw new Error('Unable to extract helper code from setup script');
  }

  const marker = match[1];
  const start = script.indexOf(match[0]);
  const afterMarker = script.indexOf('\n', start);
  const end =
    script.indexOf(`\n${marker}`, afterMarker + 1) !== -1
      ? script.indexOf(`\n${marker}`, afterMarker + 1)
      : script.indexOf(marker, afterMarker + 1);

  if (end === -1) {
    throw new Error('Unable to extract helper code from setup script');
  }

  const raw = script.slice(afterMarker + 1, end);
  return raw.replace(/\r\n/g, '\n');
}

function createHelperFixture({ encryptionEnabled = true, agentName = 'Helper Agent' } = {}) {
  const setupScript = generateDirectSetupScript(
    'TEST_KEY',
    'http://localhost:8088',
    agentName,
    encryptionEnabled ? baseSalt : null
  );
  const helperCode = extractHelperCode(setupScript);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-helper-'));
  const helperPath = path.join(dir, 'message_helper.py');
  fs.writeFileSync(helperPath, helperCode);

  const envLines = [
    'API_KEY=TEST_KEY',
    'API_BASE=http://localhost:8088/api',
    `AGENT_NAME=${agentName}`,
    `USER_PASSWORD=${encryptionEnabled ? 'p@ssw0rd' : ''}`,
    `ENCRYPTION_SALT=${encryptionEnabled ? baseSalt : ''}`
  ];
  fs.writeFileSync(path.join(dir, '.env'), envLines.join('\n'));

  return { dir, helperPath, encryptionEnabled };
}

function runHelper(helperPath, body, env = {}, cwd) {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("message_helper", ${JSON.stringify(helperPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
${body}
`;

  return spawnSync('python3', ['-c', code], {
    cwd: cwd || path.dirname(helperPath),
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

describe('Python message_helper', () => {
  it('loads configuration from .env and env fallback', () => {
    const fixture = createHelperFixture({ encryptionEnabled: true, agentName: 'Config Agent' });

    const envResult = runHelper(
      fixture.helperPath,
      'print(json.dumps({"api": mod.Config.api_key, "agent": mod.Config.agent_name, "password": mod.Config.user_password, "salt": mod.Config.encryption_salt}))'
    );
    expect(envResult.status).toBe(0);
    const loaded = JSON.parse(envResult.stdout.trim());
    expect(loaded).toEqual({
      api: 'TEST_KEY',
      agent: 'Config Agent',
      password: 'p@ssw0rd',
      salt: baseSalt
    });

    fs.unlinkSync(path.join(fixture.dir, '.env'));
    const fallback = runHelper(
      fixture.helperPath,
      'print(json.dumps({"api": mod.Config.api_key, "agent": mod.Config.agent_name, "password": mod.Config.user_password, "salt": mod.Config.encryption_salt}))',
      {
        API_KEY: 'ENV_KEY',
        API_BASE: 'http://localhost:9999/api',
        AGENT_NAME: 'Env Agent',
        USER_PASSWORD: 'env-pass',
        ENCRYPTION_SALT: baseSalt
      },
      fixture.dir
    );
    expect(fallback.status).toBe(0);
    const fallbackLoaded = JSON.parse(fallback.stdout.trim());
    expect(fallbackLoaded).toEqual({
      api: 'ENV_KEY',
      agent: 'Env Agent',
      password: 'env-pass',
      salt: baseSalt
    });
  });

  it('fails fast when required configuration is missing', () => {
    const fixture = createHelperFixture({ encryptionEnabled: true });
    fs.unlinkSync(path.join(fixture.dir, '.env'));
    const missing = runHelper(
      fixture.helperPath,
      'print("should not reach")',
      { API_KEY: '', USER_PASSWORD: '', ENCRYPTION_SALT: '' },
      fixture.dir
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/Missing required environment variables/i);
  });

  it('encrypts and decrypts payloads with salt and passes through when encryption is disabled', () => {
    const encFixture = createHelperFixture({ encryptionEnabled: true });
    const encResult = runHelper(
      encFixture.helperPath,
      `
import io, contextlib
cipher = mod._encrypt_message("hello")
print(json.dumps({
  "cipher": cipher,
  "plain": mod._decrypt_message(cipher),
  "bad": mod._decrypt_message("bad:bad:bad")
}))
`
    );
    const encPayload = JSON.parse(encResult.stdout.trim());
    expect(encResult.status).toBe(0);
    expect(encPayload.cipher).not.toBe('hello');
    expect(encPayload.plain).toBe('hello');
    expect(encPayload.bad).toBe('[Decryption failed]');

    const plainFixture = createHelperFixture({ encryptionEnabled: false });
    const plainResult = runHelper(
      plainFixture.helperPath,
      `
print(json.dumps({
  "cipher": mod._encrypt_message("plain"),
  "plain": mod._decrypt_message("plain")
}))
`
    );
    const plainPayload = JSON.parse(plainResult.stdout.trim());
    expect(plainPayload.cipher).toBe('plain');
    expect(plainPayload.plain).toBe('plain');
  });

  it('sends messages with encrypted flag and decrypts returned messages', () => {
    const fixture = createHelperFixture({ encryptionEnabled: true });
    const result = runHelper(
      fixture.helperPath,
      `
captured = {}
def fake_api(method, path, data=None):
    captured["method"] = method
    captured["path"] = path
    captured["data"] = data
    return {"success": True, "newMessages": [{"content": mod._encrypt_message("Welcome back")}]} 
mod._api_request = fake_api
response = mod.send_message("Secret hello", priority=2)
print(json.dumps({"response": response, "captured": captured}))
`
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.captured).toMatchObject({
      method: 'POST',
      path: '/agent/messages'
    });
    expect(payload.captured.data).toMatchObject({
      priority: 2,
      agentName: 'Helper Agent',
      encrypted: true
    });
    expect(payload.captured.data.content).not.toBe('Secret hello');
    expect(payload.response.newMessages[0].content).toBe('Welcome back');
  });

  it('send command can attach staged pending attachments', () => {
    const fixture = createHelperFixture({ encryptionEnabled: true });
    const result = runHelper(
      fixture.helperPath,
      `
captured = {}
def fake_api(method, path, data=None):
    captured["method"] = method
    captured["path"] = path
    captured["data"] = data
    return {"status": "sent", "messageId": "msg-attach-1"}
mod._api_request = fake_api
mod._save_pending_attachment_ids(["att-1", "att-2"])
mod.sys.argv = ["message_helper.py", "send", "Image delivered", "--use-pending-attachments"]
mod.main()
print(json.dumps({"captured": captured, "pendingAfter": mod._load_pending_attachment_ids()}))
`
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split('\n').pop());
    expect(payload.captured.path).toBe('/agent/messages');
    expect(payload.captured.data.attachmentIds).toEqual(['att-1', 'att-2']);
    expect(payload.pendingAfter).toEqual([]);
  });

  it('asks questions, carries options, and updates the last read timestamp', () => {
    const fixture = createHelperFixture({ encryptionEnabled: true });
    const result = runHelper(
      fixture.helperPath,
      `
import io, contextlib
call_log = []
captured = {}
def fake_api(method, path, data=None):
    call_log.append(f"{method}:{path}")
    if method == "GET":
        if len(call_log) == 1:
            return {"responses": [{"timestamp": "2024-01-01T00:00:00Z", "content": mod._encrypt_message("old")}]} 
        return {"responses": [{"timestamp": "2024-01-01T00:00:03Z", "content": mod._encrypt_message("fresh")}]} 
    if method == "POST":
        captured.update(data or {})
        return {"ok": True}
    return {}
mod._api_request = fake_api
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    answers = mod.ask_question("Ready?", options=[{"text": "Opt A"}], priority=1, timeout=1)
print(json.dumps({"answers": answers, "captured": captured, "log": call_log, "last": mod._last_read_time, "stdout": buf.getvalue().strip().splitlines()}))
`
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.captured).toMatchObject({
      priority: 1,
      encrypted: true
    });
    expect(payload.captured.content).not.toBe('Ready?');
    expect(payload.captured.options[0].text).toBe('Opt A');
    expect(payload.answers[0].content).toBe('fresh');
    expect(payload.last).toBe('2024-01-01T00:00:03Z');
    expect(payload.log.filter((entry) => entry.startsWith('GET')).length).toBeGreaterThanOrEqual(2);
  });

  it('fetches new messages using since cursor and updates last read time', () => {
    const fixture = createHelperFixture({ encryptionEnabled: true });
    const result = runHelper(
      fixture.helperPath,
      `
mod._last_read_time = "2024-01-01T00:00:01Z"
seen_path = {}
def fake_api(method, path, data=None):
    seen_path["path"] = path
    return {"responses": [{"timestamp": "2024-01-01T00:00:05Z", "content": mod._encrypt_message("Update")}]} 
mod._api_request = fake_api
msgs = mod.check_new_messages()
print(json.dumps({"msgs": msgs, "path": seen_path.get("path"), "last": mod._last_read_time}))
`
    );

    const payload = JSON.parse(result.stdout.trim());
    expect(payload.path).toContain('since=');
    expect(decodeURIComponent(payload.path)).toContain('since=2024-01-01T00:00:01Z');
    expect(payload.path).toContain('agentCliVersion=');
    expect(payload.msgs[0].content).toBe('Update');
    expect(payload.last).toBe('2024-01-01T00:00:05Z');
  });

  it('stages queued self-update and applies it after explicit user confirmation', () => {
    const fixture = createHelperFixture({ encryptionEnabled: true });
    const result = runHelper(
      fixture.helperPath,
      `
import os
manifest = {
  "version": "9.9.9",
  "files": {
    "AGENT_INSTRUCTIONS.md": "# Updated by self-update\\n"
  }
}
encrypted_manifest = mod._encrypt_message(json.dumps(manifest))

def phase1_api(method, path, data=None):
    return {
        "responses": [{
            "timestamp": "2026-02-01T00:00:01Z",
            "content": "System update is available.",
            "encrypted": False,
            "updateAction": {
                "type": "queued_self_update",
                "encryptedPayload": encrypted_manifest
            }
        }]
    }

mod._api_request = phase1_api
phase1 = mod.check_new_messages()
pending_before = os.path.exists(mod._PENDING_UPDATE_FILE)

def phase2_api(method, path, data=None):
    return {
        "responses": [{
            "timestamp": "2026-02-01T00:00:02Z",
            "content": "confirm update",
            "encrypted": False
        }]
    }

mod._api_request = phase2_api
phase2 = mod.check_new_messages()
pending_after = os.path.exists(mod._PENDING_UPDATE_FILE)
updated_text = ""
updated_file = os.path.join(os.path.dirname(mod.__file__), "AGENT_INSTRUCTIONS.md")
if os.path.exists(updated_file):
    with open(updated_file, "r") as f:
        updated_text = f.read()

print(json.dumps({
    "phase1": phase1,
    "phase2": phase2,
    "pendingBefore": pending_before,
    "pendingAfter": pending_after,
    "updatedText": updated_text
}))
`
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.pendingBefore).toBe(true);
    expect(payload.pendingAfter).toBe(false);
    expect(payload.phase1[0].content).toMatch(/system update available/i);
    expect(payload.phase1[0].content).toMatch(/9\.9\.9/);
    expect(payload.phase2[0].content).toMatch(/Self-update applied successfully/i);
    expect(payload.updatedText).toContain('Updated by self-update');
  });

  it('handles history retrieval and AGENT_NOT_FOUND gracefully', () => {
    const fixture = createHelperFixture({ encryptionEnabled: true });
    const notFound = runHelper(
      fixture.helperPath,
      `
mod._api_request = lambda method, path, data=None: {"error": {"code": "AGENT_NOT_FOUND"}}
print(json.dumps(mod.get_message_history()))
`
    );
    expect(notFound.status).toBe(0);
    const nfPayload = JSON.parse(notFound.stdout.trim());
    expect(nfPayload).toMatchObject({ isNewAgent: true, messageCount: 0 });

    const history = runHelper(
      fixture.helperPath,
      `
def fake_api(method, path, data=None):
    return {
        "agentName": "Helper Agent",
        "messageCount": 2,
        "messages": [
            {"content": mod._encrypt_message("Hi"), "from": "USER", "timestamp": "t1", "type": "agent_message"},
            {"freeResponse": mod._encrypt_message("Free form"), "type": "user_response", "timestamp": "t2"}
        ]
    }
mod._api_request = fake_api
print(json.dumps(mod.get_message_history()))
`
    );
    const historyPayload = JSON.parse(history.stdout.trim());
    expect(historyPayload.messages[0].content).toBe('Hi');
    expect(historyPayload.messages[1].freeResponse).toBe('Free form');
    expect(historyPayload.messageCount).toBe(2);
  });

  it('spawn_agent sends onboarding DM and frontend status message', () => {
    const fixture = createHelperFixture({ encryptionEnabled: true, agentName: 'Parent Agent' });
    const result = runHelper(
      fixture.helperPath,
      `
import os
call_log = []
parent_dir = os.path.dirname(mod.__file__)
parent_state = os.path.join(parent_dir, "agent_state")
os.makedirs(parent_state, exist_ok=True)
with open(os.path.join(parent_dir, "agent-runner.sh"), "w") as _runner:
    _runner.write("#!/usr/bin/env bash\\nexit 0\\n")
os.chmod(os.path.join(parent_dir, "agent-runner.sh"), 0o755)
with open(os.path.join(parent_state, "allowed_permissions.json"), "w") as _perms:
    json.dump({"codex": {"--sandbox": ["workspace-write", "danger-full-access"]}}, _perms)
with open(os.path.join(parent_state, "agent_config.json"), "w") as _cfg:
    json.dump({"model_provider": "codex", "model": "gpt-5-mini", "approval_mode": "full-auto", "sandbox_mode": "workspace-write", "project_path": "/tmp/parent-work"}, _cfg)

class _FakeProc:
    pid = 777

def fake_popen(cmd, cwd=None, env=None, stdout=None, stderr=None, start_new_session=None):
    call_log.append({"localRunnerCmd": cmd, "localRunnerCwd": cwd})
    return _FakeProc()

mod.subprocess.Popen = fake_popen
mod.time.sleep = lambda _seconds: None
mod.os.kill = lambda pid, sig: None

def fake_api(method, path, data=None):
    call_log.append({"method": method, "path": path, "data": data})
    if method == "POST" and path == "/agent/spawn":
        return {
            "success": True,
            "childAgent": {
                "agentId": "child-123",
                "agentName": "IdeaBot",
                "spawnDepth": 1,
                "parentAgentId": "parent-123",
                "loopPid": None,
                "runtime": {
                    "sameMachineAsParent": True,
                    "launchMode": "local_only",
                    "projectPath": "/tmp/work-from-api",
                    "config": {
                        "model_provider": "codex",
                        "model": "gpt-5",
                        "approval_mode": "full-auto",
                        "sandbox_mode": "workspace-write",
                        "project_path": "/tmp/work-from-api"
                    },
                    "allowedPermissions": {
                        "codex": {
                            "--sandbox": ["workspace-write", "danger-full-access"]
                        },
                        "inter_agent": {
                            "enabled": True,
                            "mode": "listen_all",
                            "groups": []
                        }
                    }
                }
            }
        }
    if method == "GET" and path.startswith("/agent/messages/history"):
        return {"messages": [{"content": "local child ready"}]}
    if method == "POST" and path == "/agent/messages/direct":
        return {"status": "sent", "messageId": "dm-1"}
    if method == "POST" and path == "/agent/messages":
        return {"status": "sent", "messageId": "msg-1"}
    return {}
mod._api_request = fake_api
spawned = mod.spawn_agent("IdeaBot", "Keep notes about new ideas and research them.")
child_cfg = {}
child_perms = {}
if spawned.get("_localFolderCreated"):
    with open(os.path.join(spawned["_localFolderCreated"], "agent_state", "agent_config.json"), "r") as _cf:
        child_cfg = json.load(_cf)
    with open(os.path.join(spawned["_localFolderCreated"], "agent_state", "allowed_permissions.json"), "r") as _pf:
        child_perms = json.load(_pf)
notice_call = next((c for c in call_log if c.get("path") == "/agent/messages"), None)
dm_call = next((c for c in call_log if c.get("path") == "/agent/messages/direct"), None)
decrypted_notice = ""
decrypted_dm = ""
if notice_call and notice_call.get("data") and notice_call["data"].get("content"):
    decrypted_notice = mod._decrypt_message(notice_call["data"]["content"])
if dm_call and dm_call.get("data") and dm_call["data"].get("content"):
    decrypted_dm = mod._decrypt_message(dm_call["data"]["content"])
print(json.dumps({"spawned": spawned, "calls": call_log, "decryptedNotice": decrypted_notice, "decryptedDm": decrypted_dm, "childCfg": child_cfg, "childPerms": child_perms}))
`
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.spawned).toMatchObject({
      agentId: 'child-123',
      agentName: 'IdeaBot',
      _briefingDmStatus: 'sent',
      _frontendNotificationSent: true,
      _localLoopStarted: true
    });

    const spawnCall = payload.calls.find((call) => call.path === '/agent/spawn');
    expect(spawnCall.data).toMatchObject({
      childAgentName: 'IdeaBot',
      initialInstructions: 'Keep notes about new ideas and research them.',
      canSpawn: false
    });

    const dmCall = payload.calls.find((call) => call.path === '/agent/messages/direct');
    expect(dmCall.data.toAgentName).toBe('IdeaBot');
    expect(dmCall.data.encrypted).toBe(true);
    expect(payload.decryptedDm).toContain("Spawn handoff from parent agent 'Parent Agent'");
    expect(payload.decryptedDm).toContain('Keep notes about new ideas and research them.');

    const noticeCall = payload.calls.find((call) => call.path === '/agent/messages');
    expect(noticeCall.data.agentName).toBe('Parent Agent');
    expect(payload.decryptedNotice).toContain("Child agent 'IdeaBot' spawned and confirmed running");
    expect(payload.decryptedNotice).toContain('Onboarding DM sent');
    expect(payload.childCfg.project_path).toBe('/tmp/work-from-api');
    expect(payload.childCfg.model).toBe('gpt-5');
    expect(payload.childPerms.codex['--sandbox']).toContain('workspace-write');
  });

  it('spawn CLI parsing keeps provider/model flags out of instructions', () => {
    const fixture = createHelperFixture({ encryptionEnabled: true, agentName: 'Parent Agent' });
    const result = runHelper(
      fixture.helperPath,
      `
captured = {}
def fake_api(method, path, data=None):
    if method == "POST" and path == "/agent/spawn":
        captured["spawnPayload"] = data
        return {
            "success": True,
            "childAgent": {
                "agentId": "child-xyz",
                "agentName": "IdeaChild",
                "spawnDepth": 1,
                "parentAgentId": "parent-xyz",
                "loopPid": 99
            }
        }
    if method == "POST" and path == "/agent/messages/direct":
        return {"status": "sent", "messageId": "dm-2"}
    if method == "POST" and path == "/agent/messages":
        return {"status": "sent", "messageId": "msg-2"}
    return {}
mod._api_request = fake_api
mod.time.sleep = lambda _seconds: None
mod.os.kill = lambda pid, sig: None
mod.sys.argv = [
    "message_helper.py",
    "spawn",
    "IdeaChild",
    "Keep",
    "notes",
    "--provider", "codex-cli",
    "--model", "gpt-5-mini",
    "--project-path", "/tmp/workspace",
    "--can-spawn"
]
mod.main()
print(json.dumps(captured["spawnPayload"]))
`
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split('\n').pop());
    expect(payload).toMatchObject({
      childAgentName: 'IdeaChild',
      initialInstructions: 'Keep notes',
      modelProvider: 'codex-cli',
      model: 'gpt-5-mini',
      projectPath: '/tmp/workspace',
      canSpawn: true
    });
  });

  it('spawn CLI does not treat option-like tokens as child names', () => {
    const fixture = createHelperFixture({ encryptionEnabled: false, agentName: 'Parent Agent' });
    const result = runHelper(
      fixture.helperPath,
      `
called = {"spawn": False}
def fake_api(method, path, data=None):
    if method == "POST" and path == "/agent/spawn":
        called["spawn"] = True
    return {}
mod._api_request = fake_api
mod.sys.argv = ["message_helper.py", "spawn", "--help"]
mod.main()
`
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: uv run message_helper\.py spawn <childName>/);
    expect(result.stdout).not.toMatch(/Agent spawned successfully!/);
    expect(result.stderr).toBe('');
  });

  it('spawn CLI rejects invalid option-like child names', () => {
    const fixture = createHelperFixture({ encryptionEnabled: false, agentName: 'Parent Agent' });
    const result = runHelper(
      fixture.helperPath,
      `
called = {"spawn": False}
def fake_api(method, path, data=None):
    if method == "POST" and path == "/agent/spawn":
        called["spawn"] = True
    return {}
mod._api_request = fake_api
mod.sys.argv = ["message_helper.py", "spawn", "--bogus", "child"]
mod.main()
`
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Invalid child agent name/i);
    expect(result.stdout).toMatch(/Usage: uv run message_helper\.py spawn <childName>/);
    expect(result.stderr).toBe('');
  });

  it('stop command requests stop for a target agent', () => {
    const fixture = createHelperFixture({ encryptionEnabled: false, agentName: 'Parent Agent' });
    const result = runHelper(
      fixture.helperPath,
      `
captured = {}
def fake_api(method, path, data=None):
    captured["method"] = method
    captured["path"] = path
    captured["data"] = data
    return {"agentName": "IdeaChild", "message": "Stop requested. Agent will halt at next opportunity and send confirmation message."}
mod._api_request = fake_api
mod.sys.argv = ["message_helper.py", "stop", "IdeaChild"]
mod.main()
print(json.dumps(captured))
`
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split('\n').pop());
    expect(payload).toMatchObject({
      method: 'POST',
      path: '/agent/stop',
      data: { agentName: 'IdeaChild' }
    });
  });

  it('supports CLI entrypoint commands and exits on invalid usage', () => {
    const fixture = createHelperFixture({ encryptionEnabled: false });

    const send = runHelper(
      fixture.helperPath,
      `
import io, contextlib
output = []
def fake_api(method, path, data=None):
    output.append({"method": method, "path": path, "data": data})
    return {"success": True}
mod._api_request = fake_api
mod.sys.argv = ["message_helper.py", "send", "Hello there"]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    mod.main()
print(json.dumps({"cli": buf.getvalue(), "calls": output}))
`
    );
    expect(send.status).toBe(0);
    const sendPayload = JSON.parse(send.stdout.trim());
    expect(sendPayload.calls[0].data).toMatchObject({ content: 'Hello there', encrypted: false });
    expect(sendPayload.cli).toMatch(/Message sent successfully/i);

    const ask = runHelper(
      fixture.helperPath,
      `
mod._api_request = lambda method, path, data=None: {"responses": [{"timestamp": "t1", "content": "reply"}]} if method == "GET" else {}
mod.sys.argv = ["message_helper.py", "ask", "Question?"]
mod.main()
`
    );
    expect(ask.status).toBe(0);

    const bad = runHelper(
      fixture.helperPath,
      `
mod._api_request = lambda method, path, data=None: {}
mod.sys.argv = ["message_helper.py", "unknown"]
mod.main()
`
    );
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/Unknown command/);

    const missing = runHelper(
      fixture.helperPath,
      `
mod.sys.argv = ["message_helper.py", "send"]
mod.main()
`
    );
    expect(missing.status).toBe(1);
    expect(missing.stdout).toMatch(/Message is required/);
  });

  describe('rich_html promotion', () => {
    it('auto-wraps raw HTML payloads in a rich_html envelope on send', () => {
      const fixture = createHelperFixture({ encryptionEnabled: false });
      const result = runHelper(
        fixture.helperPath,
        `
captured = {}
def fake_api(method, path, data=None):
    captured["data"] = data
    return {"status": "sent", "messageId": "msg-rich-1"}
mod._api_request = fake_api
mod.sys.argv = [
    "message_helper.py", "send",
    "<form><input name='x'/><button type='submit'>Go</button></form>"
]
mod.main()
print(json.dumps({"content": captured["data"]["content"]}))
`
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim().split('\n').pop());
      // Encryption is disabled in this fixture so content is the plain string
      const parsed = JSON.parse(payload.content);
      expect(parsed.type).toBe('rich_html');
      expect(parsed.html).toContain('<form>');
      expect(parsed.html).toContain("<input name='x'/>");
    });

    it('does NOT wrap plain text or arithmetic with stray "<" characters', () => {
      const fixture = createHelperFixture({ encryptionEnabled: false });
      const result = runHelper(
        fixture.helperPath,
        `
captured = []
def fake_api(method, path, data=None):
    captured.append(data)
    return {"status": "sent", "messageId": "msg-plain"}
mod._api_request = fake_api

mod.sys.argv = ["message_helper.py", "send", "Hello world"]
mod.main()

mod.sys.argv = ["message_helper.py", "send", "Cost < $5 today"]
mod.main()

mod.sys.argv = ["message_helper.py", "send", "**bold** and *italic* markdown"]
mod.main()

print(json.dumps([c["content"] for c in captured]))
`
      );

      expect(result.status).toBe(0);
      const contents = JSON.parse(result.stdout.trim().split('\n').pop());
      expect(contents[0]).toBe('Hello world');
      expect(contents[1]).toBe('Cost < $5 today');
      expect(contents[2]).toBe('**bold** and *italic* markdown');
    });

    it('does NOT re-wrap content that is already a rich_html envelope', () => {
      const fixture = createHelperFixture({ encryptionEnabled: false });
      const result = runHelper(
        fixture.helperPath,
        `
captured = {}
def fake_api(method, path, data=None):
    captured["data"] = data
    return {"status": "sent", "messageId": "msg-envelope"}
mod._api_request = fake_api
envelope = json.dumps({"type": "rich_html", "html": "<form>a</form>", "title": "T"})
mod.sys.argv = ["message_helper.py", "send", envelope]
mod.main()
print(json.dumps({"content": captured["data"]["content"]}))
`
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim().split('\n').pop());
      const parsed = JSON.parse(payload.content);
      expect(parsed.type).toBe('rich_html');
      expect(parsed.html).toBe('<form>a</form>');
      expect(parsed.title).toBe('T');
      // Guard: not double-wrapped
      expect(typeof parsed.html === 'string').toBe(true);
      expect(parsed.html).not.toMatch(/"type":\s*"rich_html"/);
    });

    it('also leaves rich_interactive envelopes untouched', () => {
      const fixture = createHelperFixture({ encryptionEnabled: false });
      const result = runHelper(
        fixture.helperPath,
        `
captured = {}
def fake_api(method, path, data=None):
    captured["data"] = data
    return {"status": "sent", "messageId": "msg-interactive"}
mod._api_request = fake_api
envelope = json.dumps({"type": "rich_interactive", "html": "<button>x</button>"})
mod.sys.argv = ["message_helper.py", "send", envelope]
mod.main()
print(json.dumps({"content": captured["data"]["content"]}))
`
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim().split('\n').pop());
      const parsed = JSON.parse(payload.content);
      expect(parsed.type).toBe('rich_interactive');
      expect(parsed.html).toBe('<button>x</button>');
    });

    it('--rich-html flag wraps any payload with optional --title and --description', () => {
      const fixture = createHelperFixture({ encryptionEnabled: false });
      const result = runHelper(
        fixture.helperPath,
        `
captured = {}
def fake_api(method, path, data=None):
    captured["data"] = data
    return {"status": "sent", "messageId": "msg-rich-force"}
mod._api_request = fake_api
mod.sys.argv = [
    "message_helper.py", "send",
    "<div class='card'>Hello</div>",
    "--rich-html",
    "--title", "Greeting Card",
    "--description", "A custom greeting"
]
mod.main()
print(json.dumps({"content": captured["data"]["content"]}))
`
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim().split('\n').pop());
      const parsed = JSON.parse(payload.content);
      expect(parsed.type).toBe('rich_html');
      expect(parsed.html).toBe("<div class='card'>Hello</div>");
      expect(parsed.title).toBe('Greeting Card');
      expect(parsed.description).toBe('A custom greeting');
    });

    it('helper function _maybe_promote_to_rich_html is conservative', () => {
      const fixture = createHelperFixture({ encryptionEnabled: false });
      const result = runHelper(
        fixture.helperPath,
        `
cases = {
  "plain": mod._maybe_promote_to_rich_html("hello"),
  "ltgt": mod._maybe_promote_to_rich_html("a < b > c"),
  "partial": mod._maybe_promote_to_rich_html("<not-html"),
  "form": mod._maybe_promote_to_rich_html("<form><button>go</button></form>"),
  "envelope": mod._maybe_promote_to_rich_html(json.dumps({"type": "rich_html", "html": "<div>x</div>"})),
  "force_plain": mod._maybe_promote_to_rich_html("hello", force=True, title="T"),
}
print(json.dumps(cases))
`
      );

      expect(result.status).toBe(0);
      const cases = JSON.parse(result.stdout.trim());
      expect(cases.plain).toBe('hello');
      expect(cases.ltgt).toBe('a < b > c');
      expect(cases.partial).toBe('<not-html');
      expect(JSON.parse(cases.form)).toMatchObject({ type: 'rich_html' });
      const env = JSON.parse(cases.envelope);
      expect(env.html).toBe('<div>x</div>');
      const forced = JSON.parse(cases.force_plain);
      expect(forced.type).toBe('rich_html');
      expect(forced.html).toBe('hello');
      expect(forced.title).toBe('T');
    });
  });
});
