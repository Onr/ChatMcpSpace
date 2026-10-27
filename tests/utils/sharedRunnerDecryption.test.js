// A managed agent whose saved password is wrong used to re-acquire the same
// private turn every poll and only print the failure inside tmux. These tests
// pin the visible, bounded behavior: one plain-text notice, a released slot,
// no retry loop, and recovery once the owner corrects the password.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Bridge, seal, open } = require('../../scripts/external-agent-bridge');
const { SharedRunner, envMessageKey, envPassword } = require('../../scripts/shared-agent-runner');

const SALT = Buffer.alloc(32, 7).toString('base64');
const derive = password => crypto.pbkdf2Sync(password, Buffer.from(SALT, 'base64'), 100000, 32, 'sha256').toString('base64');
const ACCOUNT_PASSWORD = 'right $pass "word" `x` \\y';
const ACCOUNT_KEY = derive(ACCOUNT_PASSWORD);
const WRONG_KEY = derive('typo');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-decrypt-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); jest.restoreAllMocks(); });

function fixture({ stateKey, candidates = [], inbox, samples = [] }) {
  const file = path.join(dir, 'shared-agent.json');
  const state = {
    version: 1, baseUrl: 'http://127.0.0.1:12345', agentName: 'knnn', agentId: crypto.randomUUID(),
    token: 'fixture', key: stateKey, history: {}, pending: null,
    shared: { runtimeId: crypto.randomUUID(), pending: null, privateExecution: null }
  };
  const calls = [];
  const fetchImpl = jest.fn(async (url, options = {}) => {
    const route = String(url).replace(state.baseUrl, '');
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ route, body });
    let json = {};
    if (route.startsWith('/api/agent/responses?')) json = { responses: inbox.splice(0, 1) };
    else if (route.startsWith('/api/agent/messages/direct?')) json = { messages: [] };
    else if (route === '/api/agent/shared/acquire') json = { config: { model_provider: 'test', model: 'test' } };
    else if (route === '/api/agent/encryption-samples') json = { samples };
    return new Response(JSON.stringify(json), { status: 200 });
  });
  const make = () => {
    const bridge = new Bridge(state, { file, runtimeKey: 'managed-local', sharedFiles: true, keyCandidates: candidates });
    const runner = new SharedRunner(bridge, [{ provider: 'test', model: 'test', command: ['node', 'unused'] }], {
      fetchImpl, invoke: jest.fn(async () => 'Done'), recoveryCommand: 'bash "/x/agent-cli.sh" --set-password "knnn"'
    });
    runner.register = jest.fn().mockResolvedValue();
    runner.sharedTurn = jest.fn().mockResolvedValue(false);
    bridge.heartbeat = jest.fn().mockResolvedValue();
    return runner;
  };
  return { state, calls, make, routes: name => calls.filter(c => c.route === name) };
}

const userMessage = () => ({ responseId: undefined, messageId: crypto.randomUUID(), encrypted: true, content: seal('Hello agent', ACCOUNT_KEY) });

test('a wrong saved key posts one plain-text notice, releases the turn and stops retrying', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const f = fixture({ stateKey: WRONG_KEY, inbox: [userMessage()] });
  let runner = f.make();
  await runner.tick();
  const notices = f.routes('/api/agent/messages');
  expect(notices).toHaveLength(1);
  expect(notices[0].body).toMatchObject({ encrypted: false, agentName: 'knnn' });
  expect(notices[0].body.content).toContain('cannot read your message');
  expect(notices[0].body.content).toContain('--set-password "knnn"');
  expect(f.routes('/api/agent/shared/acquire')).toHaveLength(1);
  expect(f.routes('/api/agent/shared/release')).toHaveLength(1);
  expect(f.state.shared.privateExecution).toBeNull();
  expect(f.state.pending.phase).toBe('queued');
  expect(f.routes('/api/agent/responses/ack')).toHaveLength(0);
  expect(console.error.mock.calls.join('\n')).toContain('does not match your account');

  for (let i = 0; i < 5; i++) await runner.tick();
  expect(f.routes('/api/agent/shared/acquire')).toHaveLength(1);
  expect(f.routes('/api/agent/messages')).toHaveLength(1);

  // A restart with the same wrong key retries once but does not repeat the notice.
  runner = f.make();
  await runner.tick();
  await runner.tick();
  expect(f.routes('/api/agent/shared/acquire')).toHaveLength(2);
  expect(f.routes('/api/agent/messages')).toHaveLength(1);
});

test('a corrected .env password is adopted and the waiting message is answered', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const f = fixture({ stateKey: WRONG_KEY, candidates: [envMessageKey({ USER_PASSWORD: ACCOUNT_PASSWORD, ENCRYPTION_SALT: SALT })], inbox: [userMessage()] });
  const runner = f.make();
  await runner.tick();
  const replies = f.routes('/api/agent/messages');
  expect(replies).toHaveLength(1);
  expect(replies[0].body.encrypted).toBe(true);
  expect(open(replies[0].body.content, ACCOUNT_KEY)).toBe('Done');
  expect(f.routes('/api/agent/responses/ack')).toHaveLength(1);
  expect(f.state.pending).toBeNull();
  expect(f.state.messageKey).toBe(ACCOUNT_KEY);
  // The local key still seals history and the shared identity, so nothing local breaks.
  expect(f.state.key).toBe(WRONG_KEY);
  expect(JSON.parse(open(Object.values(f.state.history)[0], WRONG_KEY)).at(-1)).toEqual({ role: 'assistant', content: 'Done' });
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'shared-agent.json'), 'utf8')).messageKey).toBe(ACCOUNT_KEY);
});

test('a correct key processes the message without any notice', async () => {
  const f = fixture({ stateKey: ACCOUNT_KEY, inbox: [userMessage()] });
  await f.make().tick();
  const posted = f.routes('/api/agent/messages');
  expect(posted).toHaveLength(1);
  expect(posted[0].body.encrypted).toBe(true);
  expect(f.state.messageKey).toBeUndefined();
});

test('startup check reports a wrong key from existing messages and adopts a matching candidate', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const samples = [seal('earlier', ACCOUNT_KEY)];
  await fixture({ stateKey: WRONG_KEY, inbox: [], samples }).make().checkMessageKey();
  expect(error.mock.calls.join('\n')).toMatch(/does not match your account[\s\S]*--set-password "knnn"/);

  error.mockClear();
  const fixed = fixture({ stateKey: WRONG_KEY, candidates: [ACCOUNT_KEY], inbox: [], samples });
  await fixed.make().checkMessageKey();
  expect(error).not.toHaveBeenCalled();
  expect(fixed.state.messageKey).toBe(ACCOUNT_KEY);
});

test('USER_PASSWORD_B64 wins over a mangled quoted password', () => {
  const env = { USER_PASSWORD: 'mangled', USER_PASSWORD_B64: Buffer.from(ACCOUNT_PASSWORD).toString('base64'), ENCRYPTION_SALT: SALT };
  expect(envPassword(env)).toBe(ACCOUNT_PASSWORD);
  expect(envMessageKey(env)).toBe(ACCOUNT_KEY);
  expect(envMessageKey({ USER_PASSWORD: ACCOUNT_PASSWORD, ENCRYPTION_SALT: SALT })).toBe(ACCOUNT_KEY);
  expect(envMessageKey({ ENCRYPTION_SALT: SALT })).toBeNull();
});
