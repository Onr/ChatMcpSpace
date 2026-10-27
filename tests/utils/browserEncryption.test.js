const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { messageKey, initialize, agentFile } = require('../../scripts/windows-agent-runner');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/encryption.js'), 'utf8');
function fixture() {
  const storage = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) }; };
  let salt = crypto.randomBytes(32).toString('base64');
  const samples = [];
  const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ samples }) }));
  const context = { window: { crypto: crypto.webcrypto, dispatchEvent: jest.fn() }, document: { getElementById: id => id === 'dashboardRoot' ? { getAttribute: () => salt } : null }, localStorage: storage(), sessionStorage: storage(), fetch, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa, Event: class Event {}, console };
  vm.runInNewContext(source, context);
  return { ...context, api: context.window.E2EEncryption, samples, salt: () => salt, switchAccount: () => { salt = crypto.randomBytes(32).toString('base64'); } };
}

test('each account keeps its own key and clearing one preserves the other account', async () => {
  const f = fixture(), saltA = f.salt();
  const keyA = await f.api.deriveKey('account A', saltA);
  await f.api.storeEncryptionKey(keyA);
  const ciphertext = await f.api.encryptMessage('private A', keyA);
  f.switchAccount();
  expect(await f.api.getStoredEncryptionKey()).toBeNull();
  const keyB = await f.api.deriveKey('account B', f.salt());
  await f.api.storeEncryptionKey(keyB);
  f.api.clearEncryptionKey();
  expect(f.localStorage.getItem('encryptionKey:' + saltA)).toBeTruthy();
  const bytes = Buffer.from(f.localStorage.getItem('encryptionKey:' + saltA), 'base64');
  const imported = await crypto.webcrypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']);
  expect(await f.api.decryptMessage(ciphertext, imported)).toBe('private A');
});

test('legacy keys migrate only if a ciphertext from the signed-in account decrypts', async () => {
  const f = fixture(), key = await f.api.deriveKey('old password', f.salt());
  const raw = Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', key)).toString('base64');
  f.localStorage.setItem('encryptionKey', raw);
  expect(await f.api.getStoredEncryptionKey()).toBeNull(); // New account has no messages.
  expect(f.localStorage.getItem(f.api.encryptionStorageKey())).toBeNull();
  f.samples.push(await f.api.encryptMessage('existing conversation', key));
  const migrated = await f.api.getStoredEncryptionKey();
  expect(migrated.extractable).toBe(false);
  expect(await f.api.decryptMessage(f.samples[0], migrated)).toBe('existing conversation');
  expect(f.localStorage.getItem(f.api.encryptionStorageKey())).toBe(raw);
  f.switchAccount();
  const otherKey = await f.api.deriveKey('different account', f.salt());
  f.samples.splice(0, 1, await f.api.encryptMessage('other person', otherKey));
  expect(await f.api.getStoredEncryptionKey()).toBeNull();
  for (const [, options] of f.fetch.mock.calls) expect(options.body).toBeUndefined();
});

test('connection codes use the actual browser key and are bound to the account salt', async () => {
  const f = fixture(), key = await f.api.deriveKey('an old forgotten password', f.salt());
  await f.api.storeEncryptionKey(key);
  const code = await f.api.createAgentConnectionCode();
  const bytes = await crypto.webcrypto.subtle.exportKey('raw', key);
  expect(messageKey(code, f.salt())).toBe(Buffer.from(bytes).toString('base64'));
  expect(() => messageKey(code, crypto.randomBytes(32).toString('base64'))).toThrow('another account');
  expect(() => messageKey('JETSPACE1.invalid!', f.salt())).toThrow('invalid');
  expect(f.fetch).not.toHaveBeenCalled();
});

test('a mistyped message password cannot replace the key for existing ciphertext', async () => {
  const f = fixture(), key = await f.api.deriveKey('correct', f.salt());
  await f.api.storeEncryptionKey(key);
  f.samples.push(await f.api.encryptMessage('waiting message', key));
  const before = f.localStorage.getItem(f.api.encryptionStorageKey());
  expect(await f.api.verifyMessageKey(await f.api.deriveKey('mistyped', f.salt()))).toBe(false);
  expect(f.localStorage.getItem(f.api.encryptionStorageKey())).toBe(before);
  expect(await f.api.verifyMessageKey(key)).toBe(true);
});

test('a code from another account is rejected before registering an agent', async () => {
  const f = fixture(), key = await f.api.deriveKey('password', f.salt());
  await f.api.storeEncryptionKey(key);
  const code = await f.api.createAgentConnectionCode();
  const directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'setup-code-'));
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ encryptionSalt: crypto.randomBytes(32).toString('base64') }) }));
  try {
    await expect(initialize(directory, { baseUrl: 'https://example.test', apiKey: 'owner-key', password: code, project: directory, agentName: 'test' }, { fetchImpl, resolve: () => ({}) })).rejects.toThrow('another account');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain('/encryption-info');
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(code);
    expect(fs.existsSync(agentFile(directory, 'test'))).toBe(false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
