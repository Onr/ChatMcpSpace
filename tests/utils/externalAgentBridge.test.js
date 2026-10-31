const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Bridge, seal, open, saveState, loadState, acquireLock, endpoint, REPLY_TYPE, INACTIVITY_SHUTDOWN_MS } = require('../../scripts/external-agent-bridge');
const { encryptMessage, decryptMessage } = require('../../src/utils/encryptionHelper');

function fixture() {
  const key = crypto.randomBytes(32).toString('base64');
  return { version: 1, baseUrl: 'https://chatspace.test', agentName: 'Hermes', agentId: crypto.randomUUID(), token: 'test-token', key,
    history: {}, pending: { phase: 'queued', kind: 'user', channel: 'user', id: crypto.randomUUID(),
      message: { responseType: 'text', encrypted: true, content: seal('Make a useful change.', key) } } };
}

describe('External agent bridge', () => {
  it('paces a complete polling cycle to a small quota and respects rate-limit advice', async () => {
    const headers = { 'x-ratelimit-limit': '6', 'x-ratelimit-scope': 'agent-polling', 'x-poll-interval-ms': '5000' };
    const fetchImpl = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ poll: { nextPollMs: 5000 } }), { headers }))
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { ...headers, 'retry-after': '45', 'x-poll-interval-ms': '45000' } }));
    const bridge = new Bridge(fixture(), { fetchImpl });
    await bridge.api('/heartbeat', { agentName: 'Hermes' });
    expect(bridge.nextPollMs).toBe(30000);
    await expect(bridge.api('/responses')).rejects.toMatchObject({ status: 429, retryable: true, retryMs: 45000 });
    expect(bridge.nextPollMs).toBe(45000);
  });

  it('admits a user message without waiting for a separately rate-limited peer inbox', async () => {
    const state = fixture(); state.pending = null;
    const bridge = new Bridge(state);
    const message = { messageId: 'user-new', content: 'hello' };
    bridge.api = jest.fn(async route => {
      if (route.startsWith('/responses?')) return { responses: [message] };
      throw new Error('Peer inbox is unavailable');
    });
    await expect(bridge.poll()).resolves.toBe(true);
    expect(bridge.api).toHaveBeenCalledTimes(1);
    expect(state.pending).toMatchObject({ id: 'user-new', kind: 'user', phase: 'queued' });
  });

  it('uses the existing browser/agent encryption format in both directions', () => {
    const password = 'test-only-password';
    const salt = crypto.randomBytes(32).toString('base64');
    const key = crypto.pbkdf2Sync(password, Buffer.from(salt, 'base64'), 100000, 32, 'sha256').toString('base64');
    expect(open(encryptMessage('From user', password, salt), key)).toBe('From user');
    expect(decryptMessage(seal('From Hermes', key), password, salt)).toBe('From Hermes');
    expect(() => open(seal('Private', key), crypto.randomBytes(32).toString('base64'))).toThrow();
  });

  it('retains a completed result across failed delivery and restart without running the agent twice', async () => {
    const state = fixture();
    const runtime = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'Done with evidence.' } }] }) });
    const bridge = new Bridge(state, { fetchImpl: runtime, runtimeKey: 'local-key' });
    bridge.api = jest.fn(async route => {
      if (route === '/heartbeat') return {};
      throw new Error('Connection lost');
    });
    await expect(bridge.completePending()).rejects.toThrow('Connection lost');
    expect(state.pending.phase).toBe('ready');
    const payload = { ...state.pending.reply };
    const restarted = new Bridge(JSON.parse(JSON.stringify(state)), { fetchImpl: runtime });
    restarted.api = jest.fn().mockResolvedValue({});
    await restarted.completePending();
    expect(runtime).toHaveBeenCalledTimes(1);
    expect(restarted.api.mock.calls[0]).toEqual(['/messages', payload]);
    expect(restarted.api.mock.calls[1][0]).toBe('/responses/ack');
    expect(restarted.state.pending).toBeNull();
  });

  it('does not replay an external run after an ambiguous timeout', async () => {
    const state = fixture();
    const runtime = jest.fn().mockRejectedValue(new Error('timeout'));
    const bridge = new Bridge(state, { fetchImpl: runtime, runtimeKey: 'local-key' });
    bridge.api = jest.fn().mockResolvedValue({});
    await expect(bridge.completePending()).rejects.toThrow('Inspect the runtime');
    expect(state.pending.phase).toBe('uncertain');
    await expect(bridge.completePending()).rejects.toThrow('uncertain outcome');
    expect(runtime).toHaveBeenCalledTimes(1);
    expect(bridge.api.mock.calls.some(([route]) => route.endsWith('/ack'))).toBe(false);
  });

  it('preserves an identified timeout for recovery without replaying the provider', async () => {
    const state = fixture();
    const runtime = jest.fn().mockRejectedValue(Object.assign(new Error('Provider stopped'), { code: 'PROVIDER_TIMEOUT' }));
    const bridge = new Bridge(state, { fetchImpl: runtime, runtimeKey: 'local-key' });
    bridge.api = jest.fn().mockResolvedValue({});
    await expect(bridge.completePending()).rejects.toThrow('Inspect the runtime');
    expect(state.pending).toMatchObject({ phase: 'uncertain', failureReason: 'timeout' });
    await expect(bridge.completePending()).rejects.toThrow('uncertain outcome');
    expect(runtime).toHaveBeenCalledTimes(1);
  });

  it('stops dispatch without claiming to have stopped an independent runtime', async () => {
    const runtime = jest.fn();
    const bridge = new Bridge(fixture(), { fetchImpl: runtime, runtimeKey: 'local-key' });
    bridge.api = jest.fn().mockResolvedValue({ stopRequested: true });
    await expect(bridge.tick()).rejects.toThrow('confirm external runtime state');
    expect(runtime).not.toHaveBeenCalled();
    expect(bridge.api).toHaveBeenCalledTimes(1);
  });

  it('records peer reply context without generating another automatic reply', async () => {
    const state = fixture();
    state.pending.kind = 'direct';
    state.pending.channel = 'agent:peer';
    state.pending.message = { fromAgent: 'Peer', encrypted: true,
      content: seal(JSON.stringify({ type: REPLY_TYPE, content: 'Here is the result.' }), state.key) };
    const runtime = jest.fn();
    const bridge = new Bridge(state, { fetchImpl: runtime });
    bridge.api = jest.fn().mockResolvedValue({});
    await bridge.completePending();
    expect(runtime).not.toHaveBeenCalled();
    expect(open(state.history['agent:peer'], state.key)).toContain('Here is the result.');
    expect(state.pending).toBeNull();
  });

  it('protects local state and prevents two listeners from consuming the same identity', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatspace-bridge-'));
    const file = path.join(directory, 'state.json');
    try {
      const state = fixture();
      saveState(file, state);
      expect(loadState(file)).toEqual(state);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const release = acquireLock(file);
      expect(() => acquireLock(file)).toThrow('locked');
      release();
      fs.chmodSync(file, 0o644);
      expect(() => loadState(file)).toThrow('permissions to 600');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not send credentials over insecure remote HTTP or credential-bearing URLs', () => {
    expect(endpoint('http://127.0.0.1:8642/v1/')).toBe('http://127.0.0.1:8642/v1');
    expect(() => endpoint('http://remote.example/v1')).toThrow();
    expect(() => endpoint('https://user:secret@example.com/v1')).toThrow();
  });

  it('downloads, decrypts, and durably exposes incoming images to the runtime', async () => {
    const state = fixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatspace-bridge-files-'));
    const plaintext = Buffer.from('fake png bytes');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(state.key, 'base64'), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const attachment = { attachmentId: crypto.randomUUID(), contentType: 'image/png', fileName: 'screen shot.png', encrypted: true,
      encryption: { alg: 'AES-GCM', ivBase64: iv.toString('base64'), tagBase64: cipher.getAuthTag().toString('base64') } };
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength) });
    try {
      const bridge = new Bridge(state, { fetchImpl, attachmentDir: directory });
      const prepared = await bridge.prepareRuntimeInput('Describe this', [attachment], 'user');
      expect(prepared.runtimeContent).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'image_url' })
      ]));
      expect(fs.readFileSync(prepared.attachments[0].localPath)).toEqual(plaintext);
      expect(path.dirname(prepared.attachments[0].localPath)).toBe(directory);
      expect(fetchImpl.mock.calls[0][0]).toContain(`/api/agent/attachments/${attachment.attachmentId}`);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('uploads local images referenced in a reply and keeps them across a delivery retry', async () => {
    const state = fixture();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chatspace-reply-images-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chatspace-reply-outside-'));
    fs.writeFileSync(path.join(project, 'shot one.png'), 'png-1');
    fs.writeFileSync(path.join(project, 'notes.txt'), 'text');
    fs.writeFileSync(path.join(outside, 'secret.png'), 'png-2');
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(project, 'link.png'));
    const reply = [
      `![Settings](${path.join(project, 'shot%20one.png')})`,
      `again ![](<${path.join(project, 'shot one.png')}>)`,
      `![Outside](${path.join(outside, 'secret.png')})`,
      `![Link](${path.join(project, 'link.png')})`,
      `![Notes](${path.join(project, 'notes.txt')})`,
      `![Gone](${path.join(project, 'missing.png')})`,
      '![Web](https://example.test/a.png)'
    ].join('\n');
    let uploads = 0;
    const fetchImpl = jest.fn(async url => String(url).endsWith('/api/agent/attachments')
      ? { ok: true, json: async () => ({ attachmentId: `attachment-${++uploads}` }) }
      : { ok: true, json: async () => ({ choices: [{ message: { content: reply } }] }) });
    try {
      const bridge = new Bridge(state, { fetchImpl, runtimeKey: 'local-key', replyFileRoots: [project] });
      bridge.api = jest.fn(async route => {
        if (route === '/heartbeat') return {};
        throw new Error('Connection lost');
      });
      await expect(bridge.completePending()).rejects.toThrow('Connection lost');
      expect(uploads).toBe(1);
      expect(state.pending.reply.attachmentIds).toEqual(['attachment-1']);
      const text = open(state.pending.reply.content, state.key);
      expect(text).toContain('[Image attached: Settings]');
      expect(text).toContain('again [Image attached: shot one.png]');
      expect(text).toContain('[Image not attached: Outside (outside the agent\'s project folder)]');
      expect(text).toContain('[Image not attached: Link (outside the agent\'s project folder)]');
      expect(text).toContain('[Image not attached: Notes (not a supported image type)]');
      expect(text).toContain('[Image not attached: Gone (file not found)]');
      expect(text).toContain('![Web](https://example.test/a.png)');
      expect(text).not.toContain(project);
      bridge.api = jest.fn().mockResolvedValue({});
      await bridge.completePending();
      expect(uploads).toBe(1);
      expect(bridge.api.mock.calls[0][1].attachmentIds).toEqual(['attachment-1']);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('leaves reply images alone when no local folder is approved', async () => {
    const state = fixture();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '![a](/tmp/a.png)' } }] }) });
    const bridge = new Bridge(state, { fetchImpl, runtimeKey: 'local-key' });
    bridge.api = jest.fn().mockResolvedValue({});
    await bridge.completePending();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bridge.api.mock.calls.find(([route]) => route === '/messages')[1].attachmentIds).toBeUndefined();
  });

  it('uploads encrypted files with plaintext integrity metadata', async () => {
    const state = fixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatspace-bridge-upload-'));
    const file = path.join(directory, 'notes.txt');
    fs.writeFileSync(file, 'hello bridge');
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ attachmentId: 'attachment-1' }) });
    try {
      const bridge = new Bridge(state, { fetchImpl });
      await expect(bridge.uploadAttachment(file)).resolves.toBe('attachment-1');
      const request = fetchImpl.mock.calls[0][1];
      expect(request.body).toBeInstanceOf(FormData);
      expect(await request.body.get('agentName')).toBe(state.agentName);
      expect(await request.body.get('contentType')).toBe('text/plain');
      expect(await request.body.get('sha256')).toBe(crypto.createHash('sha256').update('hello bridge').digest('hex'));
      expect((await request.body.get('file')).size).toBe(Buffer.byteLength('hello bridge'));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps general-file context in persisted runtime input only with explicit shared-files opt-in', async () => {
    const state = fixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatspace-bridge-general-'));
    const attachment = { attachmentId: crypto.randomUUID(), contentType: 'application/pdf', fileName: 'report.pdf', encrypted: false };
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Buffer.from('pdf').buffer });
    try {
      const bridge = new Bridge(state, { fetchImpl, attachmentDir: directory, sharedFiles: true });
      const prepared = await bridge.prepareRuntimeInput('Read report', [attachment], 'user');
      expect(prepared.instruction).toContain('report.pdf');
      expect(prepared.runtimeContent).toContain('report.pdf');
      const remote = new Bridge(state, { fetchImpl, attachmentDir: path.join(directory, 'remote') });
      await expect(remote.prepareRuntimeInput('Read report', [attachment], 'user')).rejects.toThrow('EXTERNAL_AGENT_SHARED_FILES=true');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('reports oversized images without silently forwarding them', async () => {
    const state = fixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatspace-bridge-large-image-'));
    const attachment = { attachmentId: crypto.randomUUID(), contentType: 'image/png', fileName: 'large.png', encrypted: false };
    const large = Buffer.alloc(8 * 1024 * 1024 + 1, 1);
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => large.buffer });
    try {
      const bridge = new Bridge(state, { fetchImpl, attachmentDir: directory });
      const prepared = await bridge.prepareRuntimeInput('Inspect', [attachment], 'user');
      expect(prepared.runtimeContent).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]));
      expect(prepared.instruction).toContain('too large for inline image forwarding');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('decrypts legacy encrypted question fields in history', () => {
    const state = fixture();
    const bridge = new Bridge(state);
    const history = { messages: [{ type: 'user_response', encrypted: false,
      selectedOption: seal('Approve', state.key), freeResponse: seal('Proceed now', state.key) }] };
    expect(bridge.formatHistory(history)[0]).toMatchObject({ selectedOption: 'Approve', freeResponse: 'Proceed now' });
  });

  it('dispatches an attachment-only message and retains its runtime context', async () => {
    const state = fixture();
    state.pending.message = { responseType: 'text', encrypted: false, content: null, attachments: [
      { attachmentId: crypto.randomUUID(), contentType: 'image/png', fileName: 'only.png', encrypted: false }
    ] };
    const body = Buffer.from('image bytes');
    const runtime = jest.fn()
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => body.buffer })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'Saw the image.' } }] }) });
    const bridge = new Bridge(state, { fetchImpl: runtime, runtimeKey: 'runtime-key', attachmentDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-only-')) });
    bridge.api = jest.fn(async route => route === '/heartbeat' ? {} : {});
    try {
      await bridge.completePending();
      const call = JSON.parse(runtime.mock.calls[1][1].body);
      expect(call.messages.at(-1).content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]));
      expect(state.pending).toBeNull();
    } finally { fs.rmSync(bridge.attachmentDir, { recursive: true, force: true }); }
  });

  it('keeps a queued attachment message unacknowledged when decryption fails', async () => {
    const state = fixture();
    const attachment = { attachmentId: crypto.randomUUID(), contentType: 'image/png', fileName: 'tampered.png', encrypted: true,
      encryption: { alg: 'AES-GCM', ivBase64: crypto.randomBytes(12).toString('base64'), tagBase64: crypto.randomBytes(16).toString('base64') } };
    state.pending.message = { responseType: 'text', encrypted: false, content: null, attachments: [attachment] };
    const bridge = new Bridge(state, { fetchImpl: jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Buffer.from('bad').buffer }),
      runtimeKey: 'runtime-key', attachmentDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bad-')) });
    bridge.api = jest.fn(async route => route === '/heartbeat' ? {} : {});
    try {
      await expect(bridge.completePending()).rejects.toThrow();
      expect(state.pending.phase).toBe('queued');
      expect(bridge.api.mock.calls.some(([route]) => route.endsWith('/ack'))).toBe(false);
    } finally { fs.rmSync(bridge.attachmentDir, { recursive: true, force: true }); }
  });

  it('has no third-party runtime dependency for standalone delivery', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../scripts/external-agent-bridge.js'), 'utf8');
    expect(source).not.toContain("require('mime-types')");
  });
  it('retrieves old attachment metadata only from its own visible history', async () => {
    const state = fixture();
    const bridge = new Bridge(state);
    const attachment = { attachmentId: crypto.randomUUID(), fileName: 'old.pdf' };
    bridge.api = jest.fn().mockResolvedValue({ messages: [{ attachments: [attachment] }] });
    bridge.downloadAttachment = jest.fn().mockResolvedValue({ localPath: '/private/old.pdf' });
    await expect(bridge.downloadFromHistory(attachment.attachmentId)).resolves.toEqual({ localPath: '/private/old.pdf' });
    expect(bridge.api).toHaveBeenCalledWith(`/messages/history?agentName=${encodeURIComponent(state.agentName)}`);
    await expect(bridge.downloadFromHistory('unknown')).rejects.toThrow('visible history');
    expect(bridge.downloadAttachment).toHaveBeenCalledTimes(1);
  });

  it('stops reading a response stream above the transfer limit before writing a file', async () => {
    const bridge = new Bridge(fixture(), { fetchImpl: async () => ({ ok: true, body: (async function* () {
      yield Buffer.alloc(10_000_000);
      yield Buffer.alloc(10_000_001);
      throw new Error('Stream should already be cancelled');
    })() }) });
    await expect(bridge.downloadAttachment({ attachmentId: crypto.randomUUID(), encrypted: false })).rejects.toThrow('20MB');
  });

  it('stops cleanly when the agent is deleted or archived on the site', async () => {
    const state = fixture();
    state.pending = null;
    const fetchImpl = jest.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ responses: [], agentDeletedOrArchived: true, agentStatus: 'deleted' }), { status: 200 })
    );
    const bridge = new Bridge(state, { fetchImpl });
    await expect(bridge.api('/responses?agentName=Hermes')).rejects.toMatchObject({
      code: 'AGENT_TERMINATED',
      retryable: false,
    });
    expect(bridge.stopped).toBe(true);
    expect(bridge.terminatedReason).toBe('deleted');
  });

  it('stops cleanly after 30 days of inactivity or lack of communication with the site', () => {
    expect(INACTIVITY_SHUTDOWN_MS).toBe(30 * 24 * 60 * 60 * 1000);
    const state = fixture();
    const bridge = new Bridge(state);
    bridge.lastActivityAt = Date.now() - INACTIVITY_SHUTDOWN_MS - 1000;
    expect(() => bridge.checkInactivity()).toThrow(/30 days/);
    expect(bridge.stopped).toBe(true);
    expect(bridge.terminatedReason).toBe('inactivity');
  });

});

describe('shared DM bridge encryption', () => {
  it('decrypts and replies across different account keys using a separate group key', () => {
    const sender = new Bridge(fixture(), {groupPassword:'a-separate-dm-secret',groupSalt:Buffer.from('team-salt').toString('base64')});
    const receiver = new Bridge(fixture(), {groupPassword:'a-separate-dm-secret',groupSalt:Buffer.from('team-salt').toString('base64')});
    const message = {fromAgent:sender.state.agentId,fromAgentId:sender.state.agentId,shared:true,encrypted:true,content:seal('Shared task',sender.groupKey)};
    expect(receiver.decode(message)).toBe('Shared task');
    const pending = {kind:'direct',id:crypto.randomUUID(),message,output:'Shared result'};
    receiver.prepareReply(pending);
    expect(pending.reply.encryptionScope).toBe('shared_dm_password');
    expect(open(pending.reply.content,sender.groupKey)).toContain('Shared result');
    expect(()=>open(pending.reply.content,sender.state.key)).toThrow();
  });
  it('does not try group keys for user messages or send a shared reply without the key', () => {
    const bridge = new Bridge(fixture(),{groupPassword:'secret',groupSalt:Buffer.from('salt').toString('base64')});
    expect(()=>bridge.decode({encrypted:true,content:seal('User',bridge.groupKey)})).toThrow();
    const noKey = new Bridge(fixture(),{groupPassword:'',groupSalt:''});
    expect(()=>noKey.prepareReply({kind:'direct',id:'id',message:{shared:true,fromAgent:'remote'},output:'Result'})).toThrow('GROUP_PASSWORD');
  });

  it('sends a peer DM when the token lacks agent.discover.read', async () => {
    const http = require('http');
    const { execFile } = require('child_process');
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push({ path: req.url, body: body && JSON.parse(body) });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/agent/connect-guide') return res.end(JSON.stringify({ externalAgentBridge: { protocolVersion: 1 } }));
        if (req.url === '/api/agent/discover') { res.statusCode = 403; return res.end(JSON.stringify({ error: { code: 'FORBIDDEN_RESOURCE' } })); }
        res.statusCode = 201; res.end('{}');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-dm-'));
    const file = path.join(dir, 'state.json');
    const state = fixture(); state.pending = null; state.baseUrl = `http://127.0.0.1:${server.address().port}`;
    saveState(file, state);
    try {
      const child = execFile(process.execPath, [path.join(__dirname, '../../scripts/external-agent-bridge.js'), 'send'],
        { env: { ...process.env, CHATSPACE_BRIDGE_STATE: file, CHATSPACE_TO_AGENT: 'Peer' } });
      child.stdin.end('Hello peer');
      const [code, stdout] = await new Promise(resolve => {
        let out = ''; child.stdout.on('data', d => { out += d; });
        child.on('close', exitCode => resolve([exitCode, out]));
      });
      expect(code).toBe(0);
      expect(stdout).toContain('Message sent.');
      const dm = requests.find(r => r.path === '/api/agent/messages/direct');
      expect(dm.body).toMatchObject({ toAgentName: 'Peer', encrypted: true });
      expect(dm.body.encryptionScope).toBeUndefined();
      expect(open(dm.body.content, state.key)).toBe('Hello peer');
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('notifies a standalone bridge owner of provider quota failures and retries delivery without replay', async () => {
  const state = fixture();
  const runtime = jest.fn(async () => new Response('{"error":{"code":"insufficient_quota","message":"PRIVATE_SECRET"}}', { status: 429 }));
  const bridge = new Bridge(state, { fetchImpl: runtime, runtimeKey: 'local-key' });
  let failed = false;
  bridge.api = jest.fn(async route => { if (route === '/messages' && !failed) { failed = true; throw new Error('offline'); } return {}; });
  await expect(bridge.completePending()).rejects.toThrow('Inspect the runtime');
  expect(state.pending).toMatchObject({ phase: 'uncertain', providerFailure: { category: 'quota' } });
  const savedNotice = { ...state.pending.failureNotice };
  expect(savedNotice.priority).toBe(1);
  expect(open(savedNotice.content, state.key)).toContain('usage or credit limit');
  expect(open(savedNotice.content, state.key)).not.toContain('PRIVATE_SECRET');
  await expect(bridge.completePending()).rejects.toThrow('uncertain outcome');
  await expect(bridge.completePending()).rejects.toThrow('uncertain outcome');
  expect(bridge.api.mock.calls.filter(([route]) => route === '/messages')).toEqual([
    ['/messages', savedNotice], ['/messages', savedNotice]
  ]);
  expect(runtime).toHaveBeenCalledTimes(1);
  expect(state.pending.failureNoticeSent).toBe(true);
});
