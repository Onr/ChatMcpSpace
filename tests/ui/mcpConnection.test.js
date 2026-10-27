/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/mcpConnection.js'), 'utf8');
const json = data => ({ ok: true, status: 200, json: async () => data });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startWorker(operations, apiMock, options = {}) {
  document.body.innerHTML = `<p id="state"></p><p id="detail"></p><label id="unlock" hidden><input id="password"><button id="unlockButton"></button></label><button id="changeKey" hidden></button><button id="reconnect"></button><button id="disconnect"></button><script id="mcp-config" type="application/json">${JSON.stringify({ grantId: 'grant-1', agentName: 'MCP agent', csrf: 'csrf-1', encryptionSalt: 'salt', ...options.config })}</script>`;
  const results = [];
  const restCalls = [];
  let encryptionCount = 0;
  window.E2EEncryption = {
    getStoredEncryptionKey: jest.fn(async () => options.storedKey === undefined ? ({ key: true }) : options.storedKey),
    decryptMessage: options.decryptMessage || (async value => ({ 'cipher-user': 'User text', 'cipher-option:a:b': 'Choice A', 'cipher-free:a:b': 'Extra detail', 'cipher-peer': 'Peer text', 'cipher-1': 'Hello again' })[value] || 'Hello'),
    encryptMessage: async () => `cipher-${++encryptionCount}`,
    deriveKey: jest.fn(async () => options.derivedKey || ({ key: true })), storeEncryptionKey: jest.fn()
  };
  if (options.config?.hostedApproved) Object.defineProperty(window.crypto, 'subtle', {
    configurable: true, value: { exportKey: options.exportKey || jest.fn(async () => new Uint8Array(32).buffer) }
  });
  const queue = [...operations];
  window.fetch = async (url, options = {}) => {
    const payload = options.body ? JSON.parse(options.body) : null;
    if (url === '/mcp/gateway/enroll') return json({ connectionId: 'connection-1', gatewaySecret: 'secret-1', agentToken: 'agt_test', agentName: 'MCP agent', encryptionSalt: 'salt' });
    if (url === '/mcp/gateway/claim') return json({ operation: queue.shift() || null });
    if (url === '/mcp/gateway/result') { results.push(payload); return json({ accepted: true }); }
    if (url === '/mcp/gateway/close') return json({ closed: true });
    restCalls.push({ url, options, payload });
    return apiMock(url, options, payload, restCalls);
  };
  window.eval(source);
  await delay(40);
  return { results, restCalls, queue, stop: async () => { document.getElementById('disconnect').click(); await delay(10); } };
}

describe('MCP browser connection worker contract', () => {
  beforeEach(() => localStorage.clear());

  test('decrypts bounded user and permitted peer inbox items and withholds encrypted update metadata', async () => {
    const run = await startWorker([{ id: 'request-1', operation: 'read_inbox', args: { limit: 10, peerRead: true, agentId: 'agent-1' } }], url => {
      if (url.startsWith('/api/agent/responses')) return json({ responses: [
        { messageId: 'user-1', responseType: 'text', content: 'cipher-user', encrypted: true, timestamp: '2026-01-01T00:00:00Z' },
        { responseId: 'response-1', responseType: 'option+open', selectedOption: 'cipher-option:a:b', freeResponse: 'cipher-free:a:b', timestamp: '2026-01-01T00:00:01Z' },
        { messageId: 'update-1', content: 'Safe system note', encrypted: false, updateAction: { encryptedPayload: 'cipher-hidden' }, timestamp: '2026-01-01T00:00:02Z' }
      ] });
      if (url === '/api/agent/messages/direct?markRead=false&limit=10') return json({ messages: [
        { messageId: 'peer-1', fromAgentId: 'allowed-peer', content: 'cipher-peer', encrypted: true, timestamp: '2026-01-01T00:00:03Z' },
        { messageId: 'peer-2', fromAgentId: 'blocked-peer', content: 'secret peer text', encrypted: false, timestamp: '2026-01-01T00:00:04Z' }
      ] });
      if (url === '/api/agent/discover') return json({ agents: [{ agentId: 'allowed-peer', agentName: 'Allowed' }] });
      throw new Error(`Unexpected API call: ${url}`);
    });
    const delivered = run.results[0].result;
    expect(delivered.map(item => item.content)).toEqual(['User text', 'Choice A\nExtra detail', 'Safe system note', 'Peer text']);
    expect(delivered[1]).toMatchObject({ messageId: 'response-1', kind: 'response' });
    expect(delivered[2].updateAction).toBeUndefined();
    expect(JSON.stringify(delivered)).not.toContain('cipher-hidden');
    expect(JSON.stringify(delivered)).not.toContain('blocked-peer');
    await run.stop();
  });

  test('reuses the same encrypted idempotent payload on retry without reusing a GCM nonce', async () => {
    const operation = { id: 'same', operation: 'send_message', args: { text: 'Hello again', idempotencyId: '11111111-1111-4111-8111-111111111111', agentId: 'agent-1' } };
    const run = await startWorker([operation, { ...operation, id: 'retry' }], url => {
      if (url === '/api/agent/messages') return json({ messageId: 'message-1', idempotent: true });
      throw new Error(`Unexpected API call: ${url}`);
    });
    await delay(30);
    const sends = run.restCalls.filter(call => call.url === '/api/agent/messages');
    expect(sends).toHaveLength(2);
    expect(sends[0].payload.content).toBe(sends[1].payload.content);
    expect(sends[0].payload.encrypted).toBe(true);
    expect(run.results.map(item => item.result.sent)).toEqual([true, true]);
    await run.stop();
  });

  test('does not start the gateway heartbeat until a delayed local unlock completes', async () => {
    const enrollments = [];
    const run = await startWorker([], url => {
      throw new Error(`Unexpected API call: ${url}`);
    }, { storedKey: null });
    const originalFetch = window.fetch;
    window.fetch = async (url, options = {}) => {
      if (url === '/mcp/gateway/enroll') enrollments.push(Date.now());
      return originalFetch(url, options);
    };
    await delay(20_050);
    expect(enrollments).toHaveLength(0);
    expect(document.getElementById('state').textContent).toBe('Locked');
    document.getElementById('password').value = 'local password';
    document.getElementById('unlockButton').click();
    await delay(50);
    expect(enrollments).toHaveLength(1);
    expect(document.getElementById('state').textContent).toBe('Connected');
    expect(window.E2EEncryption.deriveKey).toHaveBeenCalledWith('local password', 'salt');
    await run.stop();
  }, 30_000);

  test('lets the user replace a stale stored key after a decrypt failure', async () => {
    const read = { id: 'read-1', operation: 'read_thread', args: { limit: 10, agentId: 'agent-1' } };
    const run = await startWorker([read], url => {
      if (url.startsWith('/api/agent/messages/history')) return json({ messages: [
        { messageId: 'item-1', type: 'user_message', content: 'cipher-user', encrypted: true, timestamp: '2026-01-01T00:00:00Z' }
      ] });
      throw new Error(`Unexpected API call: ${url}`);
    }, {
      storedKey: { stale: true },
      derivedKey: { correct: true },
      decryptMessage: async (_cipher, key) => { if (key?.stale) throw new Error('bad key'); return 'Readable'; }
    });
    await delay(30);
    expect(run.results[0].error).toMatch(/Could not decrypt/);
    expect(document.getElementById('changeKey').hidden).toBe(false);
    document.getElementById('changeKey').click();
    document.getElementById('password').value = 'correct password';
    document.getElementById('unlockButton').click();
    await delay(20);
    run.queue.push({ ...read, id: 'read-2' });
    await delay(800);
    expect(run.results[1].result.messages[0].content).toBe('Readable');
    expect(document.getElementById('state').textContent).toBe('Connected');
    await run.stop();
  });

  test('uses the newly entered password key for hosted recovery instead of reloading a stale key', async () => {
    const oldKey = { stale: true }, newKey = { correct: true };
    const exported = [];
    let attempts = 0;
    const run = await startWorker([], url => {
      if (url === '/mcp/hosted/enable') {
        if (++attempts === 1) return { ok: false, status: 503, json: async () => ({ error: 'hosted_setup_failed' }) };
        return json({ state: 'connected' });
      }
      throw Error(`Unexpected call: ${url}`);
    }, { storedKey: oldKey, derivedKey: newKey, config: { hostedApproved: true, grantReady: true }, exportKey: async (_format, key) => { exported.push(key); return new Uint8Array(32).buffer; } });
    expect(document.getElementById('state').textContent).toBe('Connection needs attention');
    document.getElementById('changeKey').click();
    document.getElementById('password').value = 'replacement';
    document.getElementById('unlockButton').click();
    await delay(30);
    expect(exported).toEqual([oldKey, newKey]);
    expect(window.E2EEncryption.getStoredEncryptionKey).toHaveBeenCalledTimes(1);
    expect(window.E2EEncryption.getStoredEncryptionKey).toHaveBeenCalledWith({ extractable: true });
    expect(document.getElementById('state').textContent).toBe('Connected');
    expect(document.getElementById('password').value).toBe('');
    expect(document.getElementById('reconnect').disabled).toBe(true);
    await run.stop();
  });

  test('does not show Connected when a pending activation completes after Disconnect', async () => {
    let finishActivation;
    const run = await startWorker([], url => {
      if (url === '/mcp/hosted/enable') return new Promise(resolve => { finishActivation = () => resolve(json({ state: 'connected' })); });
      throw Error(`Unexpected call: ${url}`);
    }, { config: { hostedApproved: true } });
    expect(document.getElementById('reconnect').disabled).toBe(true);
    await run.stop();
    finishActivation();
    await delay(20);
    expect(document.getElementById('state').textContent).toBe('Offline');
    expect(document.getElementById('detail').textContent).toContain('access revoked');
    expect(document.getElementById('reconnect').hidden).toBe(true);
  });

  test('empty unlock keeps the password prompt usable and gives feedback', async () => {
    const run = await startWorker([], () => { throw Error('No request expected'); }, { storedKey: null });
    document.getElementById('unlockButton').click();
    await delay(10);
    expect(document.getElementById('detail').textContent).toContain('empty');
    expect(document.getElementById('unlock').hidden).toBe(false);
    expect(window.E2EEncryption.deriveKey).not.toHaveBeenCalled();
    document.getElementById('password').value = 'password';
    document.getElementById('password').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await delay(20);
    expect(document.getElementById('state').textContent).toBe('Connected');
    await run.stop();
  });
});
