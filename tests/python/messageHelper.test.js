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
    expect(payload.path).toContain('since=2024-01-01T00:00:01Z');
    expect(payload.msgs[0].content).toBe('Update');
    expect(payload.last).toBe('2024-01-01T00:00:05Z');
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
});
