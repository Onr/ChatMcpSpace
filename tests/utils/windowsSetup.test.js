const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { generateWindowsSetup, registerWindowsSetupRoutes } = require('../../src/utils/windowsSetup');
const { networkFlags, connectionError, checkConnection, verifyPrivateDirectory, resolveProvider, diagnose, providerArgs, invokeProvider, makeBridge, initialize, repairEncryption, setupCheck, waitForSetup, run, safeProviderEnv, agentFile, assertStorePath, concreteProvider } = require('../../scripts/windows-agent-runner');
const { seal, open, loadState, saveState } = require('../../scripts/external-agent-bridge');
let temporary;
beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'native-windows-test-')); });
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('Windows network bootstrap enables supported trust/proxy flags once', () => {
  const supported = new Set(['--use-system-ca', '--use-env-proxy']);
  const env = { https_proxy: 'http://proxy.example:8080' };
  expect(networkFlags({ supported, active: [], env })).toEqual(['--use-system-ca', '--use-env-proxy']);
  expect(networkFlags({ supported, active: ['--use-system-ca', '--use-env-proxy'], env })).toEqual([]);
  expect(networkFlags({ supported: new Set(), active: [], env })).toEqual([]);
  expect(networkFlags({ supported, active: [], env: {} })).toEqual(['--use-system-ca']);
});

test('connection check retries transient failures without sending credentials', async () => {
  const fetchImpl = jest.fn()
    .mockRejectedValueOnce({ cause: { code: 'ECONNRESET' } })
    .mockResolvedValueOnce({ ok: false, status: 503 })
    .mockResolvedValue({ ok: true, json: async () => ({ files: { 'windows-agent-runner.js': 'a'.repeat(64) } }) });
  const wait = jest.fn();
  await checkConnection('https://example.test', { fetchImpl, wait });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(wait.mock.calls).toEqual([[500], [1000]]);
  for (const [url, options] of fetchImpl.mock.calls) {
    expect(url).toBe('https://example.test/setup/windows/manifest.json');
    expect(options.headers).toBeUndefined();
    expect(options.body).toBeUndefined();
    expect(options.redirect).toBe('error');
  }
});

test('connection checks distinguish certificate errors and hide private error details', async () => {
  const fetchImpl = jest.fn().mockRejectedValue({ message: 'secret proxy credentials', cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'password' } });
  await expect(checkConnection('https://example.test', { fetchImpl })).rejects.toThrow('Windows trusted certificates');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const error = connectionError('https://example.test', { cause: { errors: [{ code: 'ENOTFOUND', message: 'password' }] } });
  expect(error.message).toContain('ENOTFOUND');
  expect(error.message).not.toContain('password');
});

test('connection check rejects sign-in pages and does not retry authorization failures', async () => {
  const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 403 });
  await expect(checkConnection('https://example.test', { fetchImpl })).rejects.toThrow('HTTP 403');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(checkConnection('https://example.test', { fetchImpl: async () => ({ ok: true, json: async () => ({ login: true }) }) })).rejects.toThrow('unexpected response');
  await expect(checkConnection('https://example.test', { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('HTML sign-in page'); } }) })).rejects.toThrow('network sign-in page');
});

test('connection retries are bounded when the host remains unreachable', async () => {
  const fetchImpl = jest.fn().mockRejectedValue({ cause: { code: 'ENOTFOUND' } });
  const wait = jest.fn();
  await expect(checkConnection('https://example.test', { fetchImpl, wait })).rejects.toThrow('ENOTFOUND');
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledTimes(2);
});

test('uncertain registration failures are explained and never replayed', async () => {
  const fetchImpl = jest.fn().mockRejectedValue({ cause: { code: 'ECONNRESET' } });
  await expect(initialize(temporary, { baseUrl: 'https://example.test', agentName: 'example', project: temporary, apiKey: 'secret-key', password: 'secret-password' }, { fetchImpl, resolve: () => ({}) })).rejects.toThrow('example.test (ECONNRESET)');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(agentFile(temporary, 'example'))).toBe(false);
});

test.each(['PSModulePath', 'PSMODULEPATH', 'psmodulepath'])('ACL subprocess resets inherited %s from PowerShell 7 without altering the parent', moduleKey => {
  const env = { SystemRoot: 'C:\\Windows', PATH: 'node-path', [moduleKey]: 'C:\\Program Files\\PowerShell\\7\\Modules' };
  const before = { ...env };
  const spawnSyncImpl = jest.fn((_exe, _args, options) => {
    // Model the reported PS7 -> Node -> Windows PowerShell module-load failure.
    return Object.keys(options.env || env).some(name => name.toUpperCase() === 'PSMODULEPATH')
      ? { status: 1, stderr: 'Get-Acl cannot load Microsoft.PowerShell.Security' }
      : { status: 0, stdout: '' };
  });
  expect(() => verifyPrivateDirectory("C:\\Users\\A Person's\\Jetspace", true, { platform: 'win32', env, spawnSyncImpl })).not.toThrow();
  const [exe, args, options] = spawnSyncImpl.mock.calls[0];
  expect(exe).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  expect(script).toContain("$p='C:\\Users\\A Person''s\\Jetspace'");
  expect(script).toContain('AreAccessRulesProtected');
  expect(script).toContain('ReparsePoint');
  expect(script).toContain("throw 'Public ACL'");
  expect(options.env).toEqual({ SystemRoot: env.SystemRoot, PATH: env.PATH });
  expect(env).toEqual(before);
});

test.each([{ status: 1, stderr: 'private machine detail' }, { status: null, error: { code: 'ENOENT' } }])('ACL subprocess still rejects permission and launch failures', result => {
  expect(() => verifyPrivateDirectory('C:\\Jetspace', true, { platform: 'win32', spawnSyncImpl: () => result }))
    .toThrow('Windows credential ACL check failed');
});

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
  const js = path.win32.join('C:\\Users\\A Person\\npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const resolved = resolveProvider('codex', { platform: 'win32', env: { PATH: 'C:\\Users\\A Person\\npm' }, exists: file => file === js });
  expect(resolved).toEqual({ command: process.execPath, prefix: [js] });
  expect(() => resolveProvider('codex', { env: { PATH: '' }, exists: () => false })).toThrow('Install and sign in');
});

test('native providers are discovered in quoted Windows PATH directories with spaces', () => {
  const exe = 'C:\\Users\\A Person\\.local\\bin\\claude.exe';
  expect(resolveProvider('claude', { platform: 'win32', env: { Path: 'C:\\Other;"C:\\Users\\A Person\\.local\\bin"' }, exists: file => file === exe }))
    .toEqual({ command: exe, prefix: [] });
});

test('doctor reports missing prerequisites without reading credentials or exposing errors', () => {
  const report = diagnose(temporary, { verify: () => { throw new Error('sensitive detail'); }, resolve: () => { throw new Error('secret'); } });
  expect(report.ok).toBe(false);
  expect(report.checks.every(check => !check.ok)).toBe(true);
  expect(report.providers.every(provider => !provider.available)).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(/secret|sensitive/);
});

test('doctor accepts a BOM-prefixed Windows configuration and one available provider', () => {
  for (const name of ['windows-cli.ps1', 'windows-agent-runner.js', 'external-agent-bridge.js']) fs.writeFileSync(path.join(temporary, name), 'fixture');
  fs.writeFileSync(path.join(temporary, 'installation.json'), '\uFEFF' + JSON.stringify({ baseUrl: 'https://example.test' }));
  fs.mkdirSync(path.join(temporary, 'agents'));
  fs.writeFileSync(path.join(temporary, 'agents', 'state.json'), 'credentials must not be read');
  const report = diagnose(temporary, { verify: () => {}, resolve: provider => { if (provider !== 'codex') throw new Error('missing'); } });
  expect(report.ok).toBe(true);
  expect(report.checks.every(check => check.ok)).toBe(true);
  expect(report.providers.filter(provider => provider.available).map(item => item.provider)).toEqual(['codex']);
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
    if (url.endsWith('/encryption-info')) return { ok: true, json: async () => ({ encryptionSalt: salt }) };
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
  expect(JSON.parse(calls.find(call => call.url.endsWith('/runtime-permissions')).options.body).config.sandbox_mode).toBe('read-only');
});

test('setup refuses to rotate credentials for an existing server agent', async () => {
  const fetchImpl = jest.fn(async url => ({ ok: true, json: async () => url.endsWith('/encryption-info') ? { encryptionSalt: Buffer.alloc(32).toString('base64') } : { created: false } }));
  await expect(initialize(temporary, { baseUrl: 'https://example.com', agentName: 'existing', project: temporary, apiKey: 'key', password: 'password' }, { fetchImpl, resolve: () => ({}) })).rejects.toThrow('already exists on the server');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
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

test('first-message password mismatch stays unread, records a useful error and is repairable without re-enrollment', async () => {
  const salt = crypto.randomBytes(32).toString('base64');
  const oldKey = crypto.randomBytes(32).toString('base64');
  const password = 'message password שלום 🔑';
  // Use the actual browser crypto code, not the runner encryption helper.
  const context = { window: { crypto: crypto.webcrypto }, crypto: crypto.webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa, console };
  require('vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/js/encryption.js'), 'utf8'), context);
  const browser = context.window.E2EEncryption;
  const browserKey = await browser.deriveKey(password, salt);
  const message = { messageId: 'waiting-message', responseType: 'text', encrypted: true, content: await browser.encryptMessage('Hello שלום', browserKey), attachments: [] };
  const file = path.join(temporary, 'state.json');
  saveState(file, { version: 1, baseUrl: 'https://example.com', agentName: 'Windows', agentId: 'identity', token: 'scoped-token', key: oldKey,
    history: { user: seal(JSON.stringify([{ role: 'user', content: 'Earlier conversation' }]), oldKey) }, pending: null,
    native: { project: temporary, directory: temporary, providers: ['codex'], allowEdits: false, current: { model_provider: 'codex', sandbox_mode: 'read-only' } } });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    const data = url.includes('/config?') ? { agentId: 'identity', encryptionSalt: salt, config: {} }
      : url.includes('/responses?') ? { responses: [message] } : {};
    return { ok: true, headers: new Headers(), json: async () => data };
  };
  const invoke = jest.fn();
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(run(file, { fetchImpl, invoke })).rejects.toMatchObject({ code: 'MESSAGE_DECRYPTION_FAILED' });
  } finally { log.mockRestore(); error.mockRestore(); }
  expect(invoke).not.toHaveBeenCalled();
  expect(calls.some(call => call.url.endsWith('/responses/ack'))).toBe(false);
  expect(calls.some(call => call.body?.isWorking)).toBe(false);
  expect(fs.existsSync(`${file}.runtime`)).toBe(false);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
  expect(loadState(file).native.lastError).toContain('repair-encryption');
  expect(loadState(file).pending).toMatchObject({ id: message.messageId, phase: 'queued' });
  const before = fs.readFileSync(file, 'utf8');
  calls.length = 0;
  await expect(repairEncryption(file, { password: 'wrong-password' }, { fetchImpl })).rejects.toThrow('No state was changed');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  await repairEncryption(file, { password }, { fetchImpl });
  expect(calls.every(call => call.method === 'GET')).toBe(true);
  expect(JSON.stringify(calls)).not.toContain(password);
  const fixed = loadState(file);
  expect(fixed.token).toBe('scoped-token');
  expect(fixed.native.encryptionSalt).toBe(salt);
  expect(fixed.native.lastError).toBeUndefined();
  expect(fixed.pending.message).toEqual(message);
  expect(JSON.parse(open(fixed.history.user, fixed.key))[0].content).toBe('Earlier conversation');
  expect(fs.readFileSync(file, 'utf8')).not.toContain(password);
  // Run an actual child process through the Codex adapter after repairing.
  const fixture = path.join(temporary, 'codex-fixture.js');
  fs.writeFileSync(fixture, `const fs=require('fs'); let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s=>prompt+=s); process.stdin.on('end',()=>{ if(!prompt.includes('Hello שלום') || !prompt.includes('Earlier conversation')) process.exit(2); fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1], 'Reply שלום'); });`);
  const bridge = makeBridge(fixed, file, { fetchImpl, invoke: (state, messages, signal) => invokeProvider(state, messages, signal, { resolve: () => ({ command: process.execPath, prefix: [fixture] }) }) });
  await bridge.tick();
  const sent = calls.find(call => call.url.endsWith('/messages'));
  expect(await browser.decryptMessage(sent.body.content, browserKey)).toBe('Reply שלום');
  expect(calls.at(-1).url).toContain('/responses/ack');
  expect(loadState(file).pending).toBeNull();
  expect(loadState(file).native.setupVerifiedAt).toBeDefined();
  expect(setupCheck(loadState(file), true)).toEqual({ status: 'verified' });
});

test.each(['running', 'uncertain', 'ready', 'delivered'])('encryption repair never changes a %s task or repeats its tools', async phase => {
  const file = path.join(temporary, 'state.json');
  saveState(file, { version: 1, baseUrl: 'https://example.com', agentName: 'Windows', token: 'token', key: crypto.randomBytes(32).toString('base64'), native: {}, pending: { phase, kind: 'user' } });
  const before = fs.readFileSync(file, 'utf8'), fetchImpl = jest.fn();
  await expect(repairEncryption(file, { password: 'password' }, { fetchImpl })).rejects.toThrow('Resolve the pending task');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('encryption repair without local pending work validates a read-only inbox fetch and refuses a different identity', async () => {
  const file = path.join(temporary, 'state.json'), salt = crypto.randomBytes(32).toString('base64');
  const key = crypto.pbkdf2Sync('password', Buffer.from(salt, 'base64'), 100000, 32, 'sha256').toString('base64');
  const original = { version: 1, baseUrl: 'https://example.com', agentName: 'Windows', agentId: 'identity', token: 'token', key, history: {}, native: {}, pending: null };
  saveState(file, original);
  const response = data => ({ ok: true, headers: new Headers(), json: async () => data });
  const fetchImpl = jest.fn(async url => response(url.includes('/config?') ? { agentId: 'different', encryptionSalt: salt } : {}));
  await expect(repairEncryption(file, { password: 'password' }, { fetchImpl })).rejects.toThrow('identity mismatch');
  expect(loadState(file)).toEqual(original);
  fetchImpl.mockImplementation(async url => response(url.includes('/config?') ? { agentId: 'identity', encryptionSalt: salt } : { responses: [{ responseType: 'text', encrypted: true, content: seal('hello', key) }] }));
  await repairEncryption(file, { password: 'password' }, { fetchImpl });
  expect(fetchImpl.mock.calls.at(-1)[0]).toContain('/responses?markRead=false');
  expect(loadState(file).pending).toBeNull();
  expect(fetchImpl.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
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

test('setup allows every installed provider and defaults to the first one, like Linux setup', async () => {
  const salt = crypto.randomBytes(32).toString('base64');
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: options.body && JSON.parse(options.body) });
    if (url.endsWith('/encryption-info')) return { ok: true, json: async () => ({ encryptionSalt: salt }) };
    if (url.endsWith('/register')) return { ok: true, json: async () => ({ created: true, agentId: 'identity', encryptionSalt: salt }) };
    if (url.endsWith('/runtime-enroll')) return { ok: true, json: async () => ({ agentId: 'identity', token: 'scoped-token' }) };
    return { ok: true, json: async () => ({}) };
  };
  const resolve = provider => { if (provider === 'codex') throw new Error('missing'); return { command: provider, prefix: [] }; };
  const result = await initialize(temporary, { baseUrl: 'https://example.com', agentName: 'claude only', project: temporary, apiKey: 'key', password: 'password' }, { fetchImpl, resolve });
  expect(result).toMatchObject({ provider: 'claude', providers: ['claude', 'gemini'] });
  const permissions = calls.find(call => call.url.endsWith('/runtime-permissions')).body;
  expect(permissions.config.model_provider).toBe('claude');
  expect(Object.keys(permissions.allowedPermissions)).toEqual(expect.arrayContaining(['claude', 'gemini']));
  expect(permissions.allowedPermissions.codex).toBeUndefined();
  expect(loadState(agentFile(temporary, 'claude only')).native.defaultProvider).toBe('claude');
});

test('setup stops before contacting the server when no AI CLI or the requested one is installed', async () => {
  const fetchImpl = jest.fn();
  const input = { baseUrl: 'https://example.com', agentName: 'nothing', project: temporary, apiKey: 'key', password: 'password' };
  await expect(initialize(temporary, input, { fetchImpl, resolve: () => { throw new Error('missing'); } })).rejects.toThrow('No supported AI CLI');
  await expect(initialize(temporary, { ...input, provider: 'codex' }, { fetchImpl, resolve: provider => { if (provider === 'codex') throw new Error('missing'); return {}; } })).rejects.toThrow('codex is not installed');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('dashboard "default" provider maps to the agent local default instead of always Codex', async () => {
  expect(concreteProvider('default', { defaultProvider: 'gemini', providers: ['gemini'] })).toBe('gemini');
  expect(concreteProvider('default', { providers: ['claude'] })).toBe('claude');
  expect(concreteProvider('claude', { defaultProvider: 'gemini' })).toBe('claude');
  const state = { baseUrl: 'https://example.com', agentName: 'Windows', key: crypto.randomBytes(32).toString('base64'), token: 'token',
    native: { providers: ['claude'], defaultProvider: 'claude', current: { model_provider: 'claude', model: 'default' } }, pending: { message: { runOverrides: { model_provider: 'default' } } } };
  const invoke = jest.fn(async current => { expect(current.native.current.model_provider).toBe('claude'); return 'Done'; });
  await makeBridge(state, null, { invoke }).fetch('http://127.0.0.1:8642/v1/chat/completions', { body: JSON.stringify({ messages: [] }), signal: new AbortController().signal });
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('providers installed by setup npm are found even when npm is not on PATH', () => {
  const js = path.win32.join('C:\\Users\\A Person\\AppData\\Roaming', 'npm', 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js');
  expect(resolveProvider('gemini', { platform: 'win32', env: { PATH: 'C:\\Windows', APPDATA: 'C:\\Users\\A Person\\AppData\\Roaming' }, exists: file => file === js }))
    .toEqual({ command: process.execPath, prefix: [js] });
});
