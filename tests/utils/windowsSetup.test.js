const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { generateWindowsSetup, registerWindowsSetupRoutes } = require('../../src/utils/windowsSetup');
const { resolveProvider, providerArgs, invokeProvider, makeBridge, initialize, safeProviderEnv, agentFile, assertStorePath } = require('../../scripts/windows-agent-runner');
const { seal, open, loadState } = require('../../scripts/external-agent-bridge');
let temporary;
beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'native-windows-test-')); });
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('PowerShell bootstrap and downloadable manifest match the exact runtime bytes', async () => {
  const app = express(); registerWindowsSetupRoutes(app);
  const manifest = await request(app).get('/setup/windows/manifest.json').expect(200);
  for (const [name, expected] of Object.entries(manifest.body.files)) {
    const response = await request(app).get(`/setup/windows/${name}`).expect(200);
    expect(crypto.createHash('sha256').update(response.text).digest('hex')).toBe(expected);
  }
  expect(generateWindowsSetup('https://example.com')).toContain("$BaseUrl = 'https://example.com'");
  expect(() => generateWindowsSetup('http://example.com')).toThrow();
  expect(generateWindowsSetup("https://example.com/a'b")).toContain("$BaseUrl = 'https://example.com/a''b'");
  await request(app).get('/setup/windows/package.json').expect(404);
});

test('Windows npm commands resolve to Node entrypoints without a command shell', () => {
  const js = path.join('C:\\Users\\A Person\\npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const resolved = resolveProvider('codex', { platform: 'win32', env: { PATH: 'C:\\Users\\A Person\\npm' }, exists: file => file === js });
  expect(resolved).toEqual({ command: process.execPath, prefix: [js] });
  expect(() => resolveProvider('codex', { env: { PATH: '' }, exists: () => false })).toThrow('Install and sign in');
});

test('local permission ceilings reject remote provider and permission escalation', () => {
  const local = { providers: ['codex'], allowEdits: false };
  expect(providerArgs('codex', { sandbox_mode: 'read-only' }, local, 'out')).toContain('read-only');
  expect(() => providerArgs('codex', { sandbox_mode: 'workspace-write' }, local, 'out')).toThrow('not approved locally');
  expect(() => providerArgs('codex', { sandbox_mode: 'none' }, { ...local, allowEdits: true }, 'out')).toThrow('Unrestricted');
  expect(() => providerArgs('claude', {}, local, 'out')).toThrow('not approved');
  expect(safeProviderEnv({ PATH: 'ok', USER_PASSWORD: 'secret', API_KEY: 'secret', ANTHROPIC_API_KEY: 'provider-secret' })).toEqual({ PATH: 'ok', ANTHROPIC_API_KEY: 'provider-secret' });
});

test('native provider invocation runs real tools from the selected cwd, carries Unicode on stdin and reads final output', async () => {
  const fixture = path.join(temporary, 'provider.js');
  fs.writeFileSync(fixture, `const fs=require('fs'); const args=process.argv.slice(2); let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x=>prompt+=x); process.stdin.on('end',()=>{ fs.writeFileSync('tool-result.txt','tool ran'); fs.writeFileSync(args[args.indexOf('--output-last-message')+1], 'Reply: '+prompt.includes('你好')+' cwd:'+process.cwd()); });`);
  const state = { native: { current: { model_provider: 'codex', sandbox_mode: 'workspace-write' }, providers: ['codex'], allowEdits: true, directory: temporary, project: temporary } };
  const output = await invokeProvider(state, [{ role: 'user', content: '你好; $(not-a-command)' }], new AbortController().signal, { resolve: () => ({ command: process.execPath, prefix: [fixture] }) });
  expect(output).toBe(`Reply: true cwd:${temporary}`);
  expect(fs.readFileSync(path.join(temporary, 'tool-result.txt'), 'utf8')).toBe('tool ran');
  expect(fs.readdirSync(temporary).some(name => name.startsWith('result-'))).toBe(false);
});

test('provider cancellation terminates work and does not return an unconfirmed result', async () => {
  const fixture = path.join(temporary, 'wait.js'); fs.writeFileSync(fixture, 'setInterval(()=>{},1000)');
  const controller = new AbortController();
  const state = { native: { current: { model_provider: 'claude' }, providers: ['claude'], allowEdits: false, directory: temporary, project: temporary } };
  const pending = invokeProvider(state, [], controller.signal, { resolve: () => ({ command: process.execPath, prefix: [fixture] }) });
  const timer = setTimeout(() => controller.abort(), 150);
  await expect(pending).rejects.toThrow('interrupted'); clearTimeout(timer);
});

test('setup derives the account key locally and only stores scoped credentials', async () => {
  const salt = crypto.randomBytes(32).toString('base64');
  const input = { baseUrl: 'https://example.com', agentName: 'Windows agent', project: temporary, provider: 'codex', apiKey: 'account-secret', password: 'account-password', allowEdits: false };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/register')) return { ok: true, json: async () => ({ created: true, agentId: 'identity', encryptionSalt: salt, encryptionParams: { iterations: 100000, keyLength: 256 } }) };
    if (url.endsWith('/runtime-enroll')) return { ok: true, json: async () => ({ agentId: 'identity', token: 'scoped-token' }) };
    return { ok: true, json: async () => ({}) };
  };
  await initialize(temporary, input, { fetchImpl, resolve: () => ({ command: 'provider', prefix: [] }) });
  const file = agentFile(temporary, input.agentName);
  const saved = fs.readFileSync(file, 'utf8');
  expect(saved).not.toContain(input.apiKey); expect(saved).not.toContain(input.password);
  expect(JSON.stringify(calls)).not.toContain(input.password);
  expect(loadState(file).key).toBe(crypto.pbkdf2Sync(input.password, Buffer.from(salt, 'base64'), 100000, 32, 'sha256').toString('base64'));
  expect(loadState(file).token).toBe('scoped-token');
  expect(JSON.parse(calls[1].options.body).config.sandbox_mode).toBe('read-only');
});

test('setup refuses to rotate credentials for an existing server agent', async () => {
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ created: false }) }));
  await expect(initialize(temporary, { baseUrl: 'https://example.com', agentName: 'existing', project: temporary, apiKey: 'key', password: 'password' }, { fetchImpl, resolve: () => ({}) })).rejects.toThrow('already exists on the server');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('native bridge decrypts a user task, runs its local provider, encrypts and acknowledges the reply', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  const state = { version: 1, baseUrl: 'https://example.com', agentName: 'Windows', key, token: 'token', history: {}, pending: null };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: options.body && JSON.parse(options.body) });
    let data = {};
    if (url.includes('/responses?')) data = { responses: [{ messageId: 'message-id', encrypted: true, content: seal('Please edit the project', key) }] };
    return { ok: true, headers: new Headers(), json: async () => data };
  };
  const invoke = jest.fn(async (_state, messages) => {
    expect(messages.at(-1).content).toBe('Please edit the project'); return 'Edited using local tools.';
  });
  const bridge = makeBridge(state, path.join(temporary, 'state.json'), { fetchImpl, invoke });
  await bridge.tick();
  const sent = requests.find(item => item.url.endsWith('/messages'));
  expect(open(sent.body.content, key)).toBe('Edited using local tools.');
  expect(requests.at(-1).url).toContain('/responses/ack');
  expect(state.pending).toBeNull(); expect(invoke).toHaveBeenCalledTimes(1);
});


test('private storage rejects junction-like symbolic links before reading or creating credentials', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-outside-'));
  try {
    fs.symlinkSync(outside, path.join(temporary, 'agents'), 'junction');
    expect(() => assertStorePath(temporary, path.join(temporary, 'agents', 'state.json'))).toThrow('junctions or symbolic links');
    expect(() => assertStorePath(temporary, path.join(temporary, '..', 'outside'))).toThrow('Invalid private');
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test('one-message provider overrides apply without changing the saved default', async () => {
  const state = { baseUrl: 'https://example.com', agentName: 'Windows', key: crypto.randomBytes(32).toString('base64'), token: 'token',
    native: { current: { model_provider: 'codex', model: 'default' } }, pending: { message: { runOverrides: { model_provider: 'claude', model: 'example-model' } } } };
  const invoke = jest.fn(async (current) => { expect(current.native.current.model_provider).toBe('claude'); return 'Done'; });
  const bridge = makeBridge(state, null, { invoke });
  await bridge.fetch('http://127.0.0.1:8642/v1/chat/completions', { body: JSON.stringify({ messages: [] }), signal: new AbortController().signal });
  expect(state.native.current).toEqual({ model_provider: 'codex', model: 'default' });
});
