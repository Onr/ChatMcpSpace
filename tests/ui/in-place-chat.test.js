/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { TextEncoder } = require('util');
const script = fs.readFileSync(path.join(__dirname, '../../public/js/in-place-chat.js'), 'utf8');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function context(status = 'active') {
  return {
    conversationId: 'room-one', agentId: 'agent-one', agentName: 'Mira', ownerId: 'owner-one',
    mode: 'shared', state: 'shared', role: 'participant', membershipStatus: status,
    capabilities: { read: status === 'active', send: status === 'active' }
  };
}
function mount({ pending = false, activateOnRoom = false, delayRoom = false, includeQuestion = false, longHistory = false, scrollArea = false } = {}) {
  document.body.innerHTML = '<div id="dashboardRoot" data-user-id="viewer-one" data-display-name="Viewer"></div>';
  if (scrollArea) document.body.insertAdjacentHTML('beforeend', '<div id="conversationArea"></div>');
  Object.defineProperty(window, 'crypto', { configurable: true, value: webcrypto });
  window.TextEncoder = TextEncoder;
  window.csrfToken = 'csrf';
  window.getStoredEncryptionKey = jest.fn().mockResolvedValue('account-key');
  window.SharedCrypto = {
    identity: jest.fn().mockResolvedValue({ publicKey: {}, privateKey: {} }),
    privateKey: jest.fn().mockResolvedValue('private-key'),
    unwrap: jest.fn().mockResolvedValue('conversation-key'),
    decrypt: jest.fn(async (_key, payload) => payload),
    encrypt: jest.fn(async (_key, value) => ({ v: 1, iv: 'iv', data: 'data', ...value })),
    wrap: jest.fn().mockResolvedValue('wrapped-key'),
    newKey: jest.fn().mockResolvedValue('new-key')
  };
  const messages = [
    { id: 'message-agent', seq: 1, conversation_id: 'room-one', sender_agent_id: 'agent-one', kind: 'message', recipient_principals: [{ kind: 'user', id: 'owner-one' }], payload: { text: 'Welcome' }, key_version: 1, created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'message-peer', seq: 2, conversation_id: 'room-one', sender_user_id: 'peer-one', display_name: 'Peer', kind: 'message', payload: { text: 'Hello from Peer' }, key_version: 1, created_at: '2026-01-01T00:01:00.000Z' }
  ];
  if (includeQuestion) messages.splice(1, 0, { id: 'question-one', seq: 2, conversation_id: 'room-one', sender_agent_id: 'agent-one', kind: 'question', payload: { text: 'Choose a plan', options: [{ optionId: 'option-yes', text: 'Yes', default: true }, { optionId: 'option-no', text: 'No' }] }, key_version: 1, created_at: '2026-01-01T00:00:30.000Z' });
  if (longHistory) messages.splice(0, messages.length, ...Array.from({ length: 200 }, (_, index) => ({
    id: `message-${index + 201}`, seq: index + 201, conversation_id: 'room-one', sender_user_id: 'peer-one',
    display_name: 'Peer', kind: 'message', payload: { text: `History ${index + 201}` }, key_version: 1,
    created_at: '2026-01-01T00:01:00.000Z'
  })));
  const calls = [];
  let releaseRoom;
  let markRoomStarted;
  const roomStarted = new Promise(resolve => { markRoomStarted = resolve; });
  window.fetch = jest.fn(async (requestUrl, options = {}) => {
    if (String(requestUrl).includes('/messages?before=201&limit=200')) return response([{
      id: 'message-1', seq: 1, conversation_id: 'room-one', sender_user_id: 'peer-one', display_name: 'Peer',
      kind: 'message', payload: { text: 'History 1' }, key_version: 1, created_at: '2026-01-01T00:00:00.000Z'
    }]);
    const url = String(requestUrl).replace(/\/messages\?before=9223372036854775807&limit=200/, '/messages?after=0');
    calls.push({ url, options });
    if (url.includes('/message-status?')) return response([]);
    if (url === '/api/user/shared/identity') return response({ private_key: { v: 1 } });
    if (url === '/api/user/shared/room-one') {
      if (delayRoom) {
        markRoomStarted();
        await new Promise(resolve => { releaseRoom = resolve; });
      }
      return response({
      room: { id: 'room-one', owner_id: 'owner-one', agent_id: 'agent-one', key_version: 1, membership_version: 2, rotation_required: false, member: { status: activateOnRoom || !pending ? 'active' : 'pending', role: 'participant' } },
      keys: [{ key_version: 1, wrapped_key: 'wrapped' }],
      members: [{ user_id: 'viewer-one', display_name: 'Viewer', status: 'active' }, { user_id: 'peer-one', display_name: 'Peer', status: 'active' }],
      guests: [{ guest_id: 'guest-one', display_name: 'Ari', status: 'active' }],
      agentIdentity: { public_key: {} }
      });
    }
    if (url === '/api/user/chat-threads/room-one') return response(context('active'));
    if (url.startsWith('/api/user/shared/room-one/messages?after=')) return response(messages);
    if (url === '/api/user/shared/room-one/read') return response({ ok: true });
    if (url === '/api/user/shared/room-one/files' && options.method === 'POST') return response({ id: 'uploaded-file' });
    if (url === '/api/user/shared/room-one/messages' && options.method === 'POST') {
      messages.push({ id: JSON.parse(options.body).id, seq: 3, sender_user_id: 'viewer-one', display_name: 'Viewer', kind: 'message', payload: JSON.parse(options.body).payload, reply_to: JSON.parse(options.body).replyTo, key_version: 1, created_at: '2026-01-01T00:02:00.000Z' });
      return response({ id: 'message-owner', seq: 3 });
    }
    if (url === '/api/user/shared/room-one/questions/question-one/answer' && options.method === 'POST') {
      const answer = JSON.parse(options.body);
      messages.push({ id: answer.id, seq: 4, conversation_id: 'room-one', sender_user_id: 'viewer-one', display_name: 'Viewer', kind: 'answer', question_id: 'question-one', payload: answer.payload, key_version: 1, created_at: '2026-01-01T00:03:00.000Z' });
      return response({ message: { id: answer.id } });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  window.eval(script);
  window.InPlaceChat.setContext(context(pending ? 'pending' : 'active'));
  return { calls, messages, waitForRoomRequest: () => roomStarted, releaseRoom: () => releaseRoom?.() };
}

test('access setup explains a maintenance response and clears the notice after recovery', async () => {
  mount();
  document.body.insertAdjacentHTML('beforeend', '<div id="sharingAccessNotice" hidden><span id="sharingAccessNoticeText"></span></div>');
  const fetchRoom = window.fetch;
  window.fetch = jest.fn().mockResolvedValueOnce({
    ok: false, status: 503, json: async () => { throw new SyntaxError('Maintenance HTML'); }
  }).mockImplementation(fetchRoom);
  const owner = { ...context(), role: 'owner' };
  const failed = await window.InPlaceChat.maintainOwnedAccess([owner]);
  expect(failed[0].reason).toMatchObject({ status: 503, message: 'The server is temporarily unavailable. Please try again shortly.' });
  expect(document.getElementById('sharingAccessNotice').hidden).toBe(false);
  expect(document.getElementById('sharingAccessNoticeText').textContent).toContain('temporarily unavailable');

  await window.InPlaceChat.maintainOwnedAccess([owner]);
  expect(document.getElementById('sharingAccessNotice').hidden).toBe(true);
});

test('access setup retains a server error supplied as a string', async () => {
  mount();
  window.fetch = jest.fn().mockResolvedValue(response({ error: 'Please sign in again.' }, 401));
  const failed = await window.InPlaceChat.maintainOwnedAccess([{ ...context(), role: 'owner' }]);
  expect(failed[0].reason).toMatchObject({ status: 401, message: 'Please sign in again.' });
});

test('ordinary dashboard transport decrypts one shared timeline, attributes its sender, and advances the viewer read cursor', async () => {
  const { calls } = mount();
  const messages = await window.InPlaceChat.loadTimeline();
  expect(window.fetch.mock.calls.some(([url]) => url === '/api/user/shared/room-one/messages?before=9223372036854775807&limit=200')).toBe(true);
  expect(messages.map(message => [message.messageId, message.type, message.content])).toEqual([
    ['message-agent', 'agent_message', 'Welcome'],
    ['message-peer', 'user_message', 'Hello from Peer']
  ]);
  expect(messages[1].senderName).toBe('Peer');
  expect(messages[0].sharedAudienceLabel).toBe('Owner only');
  expect(calls.some(call => call.url === '/api/user/shared/room-one/read' && JSON.parse(call.options.body).seq === 2)).toBe(true);
  expect(calls.some(call => call.url.startsWith('/api/user/messages'))).toBe(false);
});

test('quoted replies persist their reference without copying the original message into the payload', async () => {
  const { calls } = mount();
  await window.InPlaceChat.loadTimeline();
  const result = await window.InPlaceChat.sendMessage('My reply', [], { replyTo: 'message-agent' });
  const call = calls.find(({ url, options }) => url === '/api/user/shared/room-one/messages' && options.method === 'POST');
  const body = JSON.parse(call.options.body);
  expect(body.replyTo).toEqual(['message-agent']);
  expect(body.payload).not.toHaveProperty('reply');
  expect(result.messages.find(message => message.messageId === body.id).reply).toMatchObject({ messageId: 'message-agent', text: 'Welcome' });
});

test('owner keeps private history in the regular shared timeline without changing its shared read cursor', async () => {
  const { calls } = mount();
  const originalFetch = window.fetch;
  window.fetch = jest.fn((url, options) => String(url).includes('/owner-history?') ? Promise.resolve(response({
    messages: [{ messageId: 'private-image', type: 'user_message', content: 'account-encrypted', encrypted: true,
      timestamp: '2025-12-31T00:00:00.000Z', ownerPrivateHistory: true, sharedAudienceLabel: 'Owner only · private history',
      attachments: [{ attachmentId: 'private-file' }] }], nextOffset: 1, hasMore: false, boundary: '2026-01-01T00:00:00.000Z'
  })) : originalFetch(url, options));
  window.InPlaceChat.setContext({ ...context(), role: 'owner' });
  let ready;
  const historyReady = new Promise(resolve => { ready = resolve; });
  window.DashboardHelpers = { ownerHistoryUpdated: ready };
  const initial = await window.InPlaceChat.loadTimeline();
  expect(initial.some(message => message.messageId === 'message-peer')).toBe(true);
  await historyReady;
  const messages = await window.InPlaceChat.loadTimeline();
  expect(messages.map(message => message.messageId)).toEqual(['private-image', 'message-agent', 'message-peer']);
  expect(messages[0]).toMatchObject({ encrypted: true, ownerPrivateHistory: true, sharedAudienceLabel: 'Owner only · private history' });
  expect(calls.filter(call => call.url.endsWith('/read')).every(call => JSON.parse(call.options.body).seq === 2)).toBe(true);
  expect(await window.InPlaceChat.loadTimeline()).toHaveLength(3);
  expect(window.fetch.mock.calls.filter(([url]) => String(url).includes('/owner-history?'))).toHaveLength(1);
  window.InPlaceChat.setContext(context());
  expect(await window.InPlaceChat.loadTimeline()).toHaveLength(2);
});

test('agent-read receipts refresh existing shared messages without requiring a new timeline sequence', async () => {
  const { messages } = mount();
  window.DashboardHelpers = { updateMessageReceipts: jest.fn() };
  window.InPlaceChat.setContext(context());
  const initial = await window.InPlaceChat.loadTimeline();
  expect(initial.find(item => item.messageId === 'message-peer')).toMatchObject({ readAt: null, serverReceived: true, deliveryState: 'delivered' });
  const base = window.fetch;
  window.fetch = jest.fn((url, options) => String(url).includes('/message-status?')
    ? Promise.resolve(response([{ messageId: 'message-peer', readAt: '2026-10-13T01:00:00Z' }])) : base(url, options));
  await window.InPlaceChat.loadTimeline();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(window.DashboardHelpers.updateMessageReceipts).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ messageId: 'message-peer', readAt: '2026-10-13T01:00:00Z', deliveryState: 'read' })
  ]));
  // A stale timeline row must not downgrade a confirmed agent receipt.
  messages.find(item => item.id === 'message-peer').agent_read_at = null;
  expect((await window.InPlaceChat.loadTimeline()).find(item => item.messageId === 'message-peer').readAt).toBe('2026-10-13T01:00:00Z');
});

test('a delayed optional receipt request cannot block a chat or update another selected context', async () => {
  mount();
  window.DashboardHelpers = { updateMessageReceipts: jest.fn() };
  window.InPlaceChat.setContext(context());
  await window.InPlaceChat.loadTimeline();
  let release;
  const base = window.fetch;
  window.fetch = jest.fn((url, options) => String(url).includes('/message-status?')
    ? new Promise(resolve => { release = resolve; }) : base(url, options));
  await window.InPlaceChat.loadTimeline();
  expect(release).toBeDefined();
  window.InPlaceChat.setContext(null);
  window.DashboardHelpers.updateMessageReceipts.mockClear();
  release(response([{ messageId: 'message-peer', readAt: '2026-10-13T01:00:00Z' }]));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(window.DashboardHelpers.updateMessageReceipts).not.toHaveBeenCalled();
});

test('the owner timeline includes guest messages and every reply audience together with sender and visibility information', async () => {
  const { messages } = mount();
  const originalFetch = window.fetch;
  window.fetch = jest.fn((url, options) => String(url).includes('/owner-history?')
    ? Promise.resolve(response({ messages: [], nextOffset: 0, hasMore: false })) : originalFetch(url, options));
  const targets = [{ kind: 'user', id: 'owner-one' }, { kind: 'guest', id: 'guest-one' }];
  messages.push(
    { id: 'guest-message', seq: 3, sender_guest_id: 'guest-one', kind: 'message', payload: { text: 'Guest message' }, key_version: 1, created_at: '2026-01-01T00:02:00Z' },
    { id: 'selected-reply', seq: 4, sender_agent_id: 'agent-one', recipient_principals: targets, kind: 'message', payload: { text: 'Selected reply' }, key_version: 1, created_at: '2026-01-01T00:03:00Z' },
    { id: 'everyone-reply', seq: 5, sender_agent_id: 'agent-one', recipient_principals: [], kind: 'message', payload: { text: 'Everyone reply' }, key_version: 1, created_at: '2026-01-01T00:04:00Z' },
    { id: 'guest-answer', seq: 6, sender_guest_id: 'guest-one', recipient_principals: targets, kind: 'answer', payload: { text: 'Answer to selected question' }, key_version: 1, created_at: '2026-01-01T00:05:00Z' }
  );
  window.InPlaceChat.setContext({ ...context(), role: 'owner' });
  const timeline = await window.InPlaceChat.loadTimeline();
  expect(timeline.map(message => message.messageId)).toEqual(messages.map(message => message.id));
  expect(timeline[0]).toMatchObject({ sharedAudienceLabel: 'Owner only', sharedSenderKind: 'agent' });
  expect(timeline[2]).toMatchObject({ senderName: 'Ari', sharedSenderKind: 'guest', sharedAudienceLabel: 'Everyone' });
  expect(timeline[3]).toMatchObject({ sharedAudienceLabel: 'Owner + Ari', sharedAudienceMode: 'selected' });
  expect(timeline[4]).toMatchObject({ sharedAudienceLabel: 'Everyone', sharedAudienceMode: 'all' });
  expect(timeline[5]).toMatchObject({ senderName: 'Ari', sharedAudienceLabel: 'Owner + Ari' });
  expect(new Set(timeline.map(message => message.sharedConversationId))).toEqual(new Set(['room-one']));
});

test('new owner-only replies refresh in the same chat without reencrypting cached rows or moving the older-history boundary', async () => {
  mount();
  let now = Date.now(), page = 0;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const originalFetch = window.fetch;
    window.fetch = jest.fn((url, options) => {
      if (!String(url).includes('/owner-history?')) return originalFetch(url, options);
      page += 1;
      return Promise.resolve(response(page === 1
        ? { messages: [{ messageId: 'private-old', content: 'ciphertext', encrypted: true, timestamp: '2025-12-31' }], nextOffset: 1, boundary: '2026-01-01', hasMore: true }
        : page === 2
          ? { messages: [{ messageId: 'private-old', content: 'ciphertext', encrypted: true, timestamp: '2025-12-31', type: 'user_message', readAt: '2026-10-13T01:00:00Z', deliveryState: 'read' },
            { messageId: 'private-new', content: 'new reply', ownerPrivateHistory: true, timestamp: '2026-01-02' }], nextOffset: 2, boundary: '2026-01-03', hasMore: true }
          : { messages: [{ messageId: 'private-older', content: 'older history', timestamp: '2025-12-30' }], nextOffset: 2, boundary: '2026-01-01', hasMore: false }));
    });
    window.InPlaceChat.setContext({ ...context(), role: 'owner' });
    let historyReady;
    const updated = jest.fn(timeline => historyReady?.(timeline));
    window.DashboardHelpers = { ownerHistoryUpdated: (_room, timeline) => updated(timeline) };
    const initialReady = new Promise(resolve => { historyReady = resolve; });
    await window.InPlaceChat.loadTimeline();
    const initial = await initialReady;
    const oldRow = initial.find(message => message.messageId === 'private-old');
    oldRow.content = 'locally decrypted'; oldRow.encrypted = false;
    now += 10001;
    const refreshed = new Promise(resolve => { historyReady = resolve; });
    await window.InPlaceChat.loadTimeline();
    const timeline = await refreshed;
    expect(timeline.find(message => message.messageId === 'private-old')).toBe(oldRow);
    expect(oldRow).toMatchObject({ content: 'locally decrypted', encrypted: false, readAt: '2026-10-13T01:00:00Z', deliveryState: 'read' });
    expect(timeline.find(message => message.messageId === 'private-new')).toMatchObject({ ownerPrivateHistory: true });
    await window.InPlaceChat.loadOlderTimeline();
    const historyCalls = window.fetch.mock.calls.filter(([url]) => String(url).includes('/owner-history?'));
    expect(new URL(historyCalls[2][0], 'http://localhost').searchParams.get('offset')).toBe('1');
    expect(new URL(historyCalls[2][0], 'http://localhost').searchParams.get('boundary')).toBe('2026-01-01');
    // The pagination caller renders the combined result once; the owner-history
    // callback is only needed for independently arriving private messages.
    expect(updated).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});

test('a delayed read receipt cannot hold messages behind the loading screen', async () => {
  mount();
  const originalFetch = window.fetch;
  let finishRead;
  window.fetch = jest.fn((url, options) => String(url).endsWith('/read')
    ? new Promise(resolve => { finishRead = () => resolve(response({ ok: true })); }) : originalFetch(url, options));
  const loaded = await window.InPlaceChat.loadTimeline();
  expect(loaded.map(message => message.messageId)).toEqual(['message-agent', 'message-peer']);
  finishRead();
});

test('a delayed private history request leaves shared messages available and updates only its own chat', async () => {
  mount();
  const originalFetch = window.fetch;
  let finishHistory;
  window.DashboardHelpers = { ownerHistoryUpdated: jest.fn(), ownerHistoryStatus: jest.fn() };
  window.fetch = jest.fn((url, options) => String(url).includes('/owner-history?')
    ? new Promise(resolve => { finishHistory = () => resolve(response({ messages: [{ messageId: 'private', ownerPrivateHistory: true }], nextOffset: 1 })); })
    : originalFetch(url, options));
  window.InPlaceChat.setContext({ ...context(), role: 'owner' });
  expect(await window.InPlaceChat.loadTimeline()).toHaveLength(2);
  window.InPlaceChat.setContext({ ...context(), conversationId: 'different-room' });
  finishHistory();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(window.DashboardHelpers.ownerHistoryUpdated).not.toHaveBeenCalled();
});

test('a stalled conversation lookup aborts with retry guidance instead of waiting forever', async () => {
  mount();
  jest.useFakeTimers();
  window.fetch = jest.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new window.DOMException('Aborted', 'AbortError')));
  }));
  const lookup = window.InPlaceChat.resolveAgentContext('agent-one');
  const rejected = expect(lookup).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', message: expect.stringContaining('try again') });
  jest.advanceTimersByTime(15001);
  await rejected;
  jest.useRealTimers();
});

test('two sends during asynchronous image encryption upload and submit only one message', async () => {
  const { calls } = mount();
  window.SharedCrypto.unwrap = async () => window.crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', true, ['encrypt', 'decrypt']);
  const files = [{ id: 'image-entry', file: { name: 'photo.png', type: 'image/png', size: 4,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer } }];
  let release;
  window.SharedCrypto.encrypt.mockImplementationOnce((_key, value) => new Promise(resolve => { release = () => resolve({ v: 1, iv: 'iv', data: 'data', ...value }); }));
  const first = window.InPlaceChat.sendMessage('One image', files);
  const second = window.InPlaceChat.sendMessage('One image', files);
  expect(second).toBe(first);
  while (!release) await Promise.resolve();
  release();
  await Promise.all([first, second]);
  expect(calls.filter(call => call.url.endsWith('/messages') && call.options.method === 'POST')).toHaveLength(1);
  expect(calls.filter(call => call.url.endsWith('/files') && call.options.method === 'POST')).toHaveLength(1);
});

test('an accepted send remains successful if refreshing the transcript fails afterward', async () => {
  const { calls } = mount();
  const originalFetch = window.fetch;
  window.fetch = jest.fn((url, options) => String(url).includes('/messages?') ? Promise.resolve(response({}, 503)) : originalFetch(url, options));
  const result = await window.InPlaceChat.sendMessage('Accepted once');
  expect(result.refreshError).toBeTruthy();
  expect(calls.filter(call => call.url.endsWith('/messages') && call.options.method === 'POST')).toHaveLength(1);
  expect(window.sessionStorage.getItem('shared-dashboard-outbox:viewer-one:room-one')).toBeNull();
});

function mountRecoveryNotice(runtime = {}, control = async () => response({ ok: true })) {
  mount();
  document.body.insertAdjacentHTML('beforeend', '<aside id="sharingExecutionNotice" hidden><span id="sharingExecutionError"></span><button id="sharingExecutionSkip"></button><button id="sharingExecutionRetry"></button></aside>');
  const originalFetch = window.fetch;
  window.confirm = jest.fn().mockReturnValue(true);
  window.fetch = jest.fn(async (url, options) => {
    if (String(url).includes('/owner-history?')) return response({ messages: [], nextOffset: 0 });
    if (String(url).endsWith('/control')) return control(url, options);
    const result = await originalFetch(url, options);
    if (String(url) === '/api/user/shared/room-one') {
      const value = await result.json();
      return response({ ...value, runtime: { execution_uncertain: true, execution_kind: 'shared',
        execution_id: 'batch-one', execution_conversation_id: 'room-one', ...runtime } });
    }
    return result;
  });
  window.InPlaceChat.setContext({ ...context(), role: 'owner' });
}

test.each(['skip', 'retry'])('%s recovers once without a browser confirmation and stale polls cannot show it again', async action => {
  const runtime = {};
  mountRecoveryNotice(runtime);
  await window.InPlaceChat.loadTimeline();
  expect(document.getElementById('sharingExecutionNotice').hidden).toBe(false);
  const recover = document.getElementById(action === 'skip' ? 'sharingExecutionSkip' : 'sharingExecutionRetry').onclick;
  await recover();
  const requests = window.fetch.mock.calls.filter(([url]) => url.endsWith('/control'));
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0][1].body)).toEqual({ action, executionId: 'batch-one' });
  expect(window.confirm).not.toHaveBeenCalled();
  expect(document.getElementById('sharingExecutionNotice').hidden).toBe(true);
  await window.InPlaceChat.loadTimeline();
  expect(document.getElementById('sharingExecutionNotice').hidden).toBe(true);
  runtime.execution_id = 'batch-two';
  await window.InPlaceChat.loadTimeline();
  expect(document.getElementById('sharingExecutionNotice').hidden).toBe(false);
  window.InPlaceChat.setContext({ ...context(), conversationId: 'another-room' });
  const count = window.fetch.mock.calls.length;
  await recover();
  expect(window.fetch.mock.calls).toHaveLength(count);
});

test.each([
  { execution_conversation_id: 'another-room' },
  { execution_kind: 'private' },
  { execution_id: null },
  { execution_uncertain: false }
])('recovery stays hidden for unrelated or finished executions: %j', async runtime => {
  mountRecoveryNotice(runtime);
  await window.InPlaceChat.loadTimeline();
  expect(document.getElementById('sharingExecutionNotice').hidden).toBe(true);
  expect(window.fetch.mock.calls.some(([url]) => url.endsWith('/control'))).toBe(false);
});

test('recovery disables both actions across polls and an error permits another attempt', async () => {
  let finish;
  const control = jest.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(response({ ok: true }));
  mountRecoveryNotice({}, control);
  await window.InPlaceChat.loadTimeline();
  const retry = document.getElementById('sharingExecutionRetry');
  const skip = document.getElementById('sharingExecutionSkip');
  const first = retry.onclick();
  await window.InPlaceChat.loadTimeline();
  expect(retry.disabled).toBe(true);
  expect(skip.disabled).toBe(true);
  await skip.onclick();
  expect(control).toHaveBeenCalledTimes(1);
  finish(response({ error: { message: 'Connection interrupted' } }, 503));
  await first;
  expect(document.getElementById('sharingExecutionError').textContent).toBe('Connection interrupted');
  expect(retry.disabled).toBe(false);
  expect(skip.disabled).toBe(false);
  await retry.onclick();
  expect(control).toHaveBeenCalledTimes(2);
  expect(document.getElementById('sharingExecutionNotice').hidden).toBe(true);
});

test('ordinary shared chat advances its timeline cursor between polls', async () => {
  const { calls } = mount();
  await window.InPlaceChat.loadTimeline();
  const loaded = await window.InPlaceChat.loadTimeline();
  const timelineCalls = calls.filter(call => call.url.includes('/messages?after='));
  expect(timelineCalls).toHaveLength(2);
  const incremental = new URL(timelineCalls[1].url, 'https://space.example');
  expect(incremental.searchParams.get('after')).toBe('2');
  expect(incremental.searchParams.get('since')).toBeTruthy();
  expect(loaded).toHaveLength(2);
});

test('ordinary shared chat opens with the newest window and fetches older history on demand', async () => {
  const { calls } = mount({ longHistory: true });
  const recent = await window.InPlaceChat.loadTimeline();
  expect(recent).toHaveLength(200);
  expect(recent[0].sharedSequence).toBe(201);
  expect(window.fetch.mock.calls.some(([url]) => String(url).includes('/messages?before=9223372036854775807&limit=200'))).toBe(true);
  const complete = await window.InPlaceChat.loadOlderTimeline();
  expect(complete).toHaveLength(201);
  expect(complete[0]).toMatchObject({ messageId: 'message-1', sharedSequence: 1 });
  expect(window.fetch.mock.calls.some(([url]) => String(url).includes('/messages?before=201&limit=200'))).toBe(true);
});

test('scrolling near the top loads one older page, preserves the render path, and stops at the end', async () => {
  mount({ longHistory: true, scrollArea: true });
  window.DashboardHelpers = { prependSharedHistory: jest.fn().mockResolvedValue(), sharedHistoryLoading: jest.fn() };
  await window.InPlaceChat.loadTimeline();
  const area = document.getElementById('conversationArea');
  area.scrollTop = 500;
  area.dispatchEvent(new Event('scroll'));
  expect(window.InPlaceChat.isLoadingOlder()).toBeFalsy();
  area.scrollTop = 0;
  area.dispatchEvent(new Event('scroll'));
  area.dispatchEvent(new Event('scroll'));
  await window.InPlaceChat.loadOlderTimeline();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(window.fetch.mock.calls.filter(([url]) => String(url).includes('/messages?before=201&limit=200'))).toHaveLength(1);
  expect(window.DashboardHelpers.prependSharedHistory).toHaveBeenCalledTimes(1);
  expect(window.DashboardHelpers.prependSharedHistory.mock.calls[0][1]).toHaveLength(201);
  expect(window.InPlaceChat.hasOlderMessages()).toBe(false);
  const completedCalls = window.fetch.mock.calls.length;
  area.dispatchEvent(new Event('scroll'));
  expect(window.fetch.mock.calls).toHaveLength(completedCalls);
  delete window.DashboardHelpers;
});

test('a delayed older page cannot render into a different selected chat', async () => {
  mount({ longHistory: true, scrollArea: true });
  window.DashboardHelpers = { prependSharedHistory: jest.fn(), sharedHistoryLoading: jest.fn() };
  await window.InPlaceChat.loadTimeline();
  const originalFetch = window.fetch;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  window.fetch = jest.fn(async (url, options) => {
    if (String(url).includes('/messages?before=201&limit=200')) await gate;
    return originalFetch(url, options);
  });
  document.getElementById('conversationArea').dispatchEvent(new Event('scroll'));
  const pendingPage = window.InPlaceChat.loadOlderTimeline();
  window.InPlaceChat.setContext(null);
  release();
  await pendingPage;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(window.DashboardHelpers.prependSharedHistory).not.toHaveBeenCalled();
  delete window.DashboardHelpers;
});

test('loading older shared history does not skip deletion updates in the next incremental poll', async () => {
  jest.useFakeTimers();
  try {
    mount({ longHistory: true });
    jest.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    await window.InPlaceChat.loadTimeline();
    jest.setSystemTime(new Date('2026-10-11T12:00:05Z'));
    await window.InPlaceChat.loadTimeline();
    jest.setSystemTime(new Date('2026-10-11T12:00:10Z'));
    await window.InPlaceChat.loadOlderTimeline();
    jest.setSystemTime(new Date('2026-10-11T12:00:15Z'));
    await window.InPlaceChat.loadTimeline();
    const updates = window.fetch.mock.calls.map(([url]) => String(url)).filter(url => url.includes('/messages?after='));
    expect(new URL(updates.at(-1), 'https://space.example').searchParams.get('since')).toBe('2026-10-11T12:00:05.000Z');
  } finally { jest.useRealTimers(); }
});

test('ordinary dashboard composer posts encrypted text to the selected conversation with a retry-stable ID', async () => {
  const { calls } = mount();
  await window.InPlaceChat.loadTimeline();
  const result = await window.InPlaceChat.sendMessage('A shared reply');
  const send = calls.find(call => call.url === '/api/user/shared/room-one/messages' && call.options.method === 'POST');
  expect(JSON.parse(send.options.body)).toMatchObject({ keyVersion: 1, payload: { text: 'A shared reply' }, addressedTo: [], replyTo: [] });
  expect(result.messages.at(-1)).toMatchObject({ messageId: JSON.parse(send.options.body).id, type: 'user_message', senderName: 'You' });
  expect(result.preserveDraft).toBe(false);
  expect(calls.some(call => call.url.startsWith('/api/user/messages'))).toBe(false);
});

test('ordinary shared composer encrypts and uploads attachments before linking them in the shared message', async () => {
  const { calls } = mount();
  window.SharedCrypto.unwrap = async () => window.crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', true, ['encrypt','decrypt']);
  await window.InPlaceChat.loadTimeline();
  const file = { name: 'shared-notes.txt', type: 'text/plain', size: 4, arrayBuffer: async () => new Uint8Array([1,2,3,4]).buffer };
  const result = await window.InPlaceChat.sendMessage('See attached', [{ id: 'composer-entry-one', file }]);
  const upload = calls.find(call => call.url === '/api/user/shared/room-one/files' && call.options.method === 'POST');
  const send = calls.find(call => call.url === '/api/user/shared/room-one/messages' && call.options.method === 'POST');
  expect(upload).toBeDefined();
  expect(upload.options.body.get('id')).toBe(JSON.parse(send.options.body).fileIds[0]);
  expect(JSON.parse(send.options.body).payload.files).toEqual([{ id: JSON.parse(send.options.body).fileIds[0], name: 'shared-notes.txt', type: 'text/plain', size: 4 }]);
  expect(result.messages.at(-1).attachments[0]).toMatchObject({ fileName: 'shared-notes.txt', sharedConversationId: 'room-one' });
});

test('switching rooms while key context is loading prevents the old draft from being sent anywhere', async () => {
  const { calls, waitForRoomRequest, releaseRoom } = mount({ delayRoom: true });
  const pending = window.InPlaceChat.sendMessage('Room A draft');
  await waitForRoomRequest();
  window.InPlaceChat.setContext({ ...context(), conversationId: 'room-two' });
  releaseRoom();
  await expect(pending).rejects.toThrow('Conversation changed before the message was sent');
  expect(calls.some(call => call.url.endsWith('/messages') && call.options.method === 'POST')).toBe(false);
});

test('ambiguous-send retry reuses its encrypted outbox body and preserves a newer composer draft', async () => {
  const { calls } = mount();
  await window.InPlaceChat.loadTimeline();
  const outboxKey = 'shared-dashboard-outbox:viewer-one:room-one';
  window.sessionStorage.setItem(outboxKey, JSON.stringify({
    id: 'original-request-id', keyVersion: 1, payload: { v: 1, iv: 'iv', data: 'ciphertext', text: 'Original sent text' },
    addressedTo: [], replyTo: [], fileIds: []
  }));
  const result = await window.InPlaceChat.sendMessage('Newer draft');
  const send = calls.find(call => call.url === '/api/user/shared/room-one/messages' && call.options.method === 'POST');
  expect(JSON.parse(send.options.body)).toMatchObject({ id: 'original-request-id', payload: { text: 'Original sent text' } });
  expect(JSON.parse(send.options.body)).not.toHaveProperty('plaintext');
  expect(result.preserveDraft).toBe(true);
  expect(window.sessionStorage.getItem(outboxKey)).toBeNull();
});

test('pending shared membership does not fall back to private APIs or allow a send', async () => {
  const { calls } = mount({ pending: true });
  await expect(window.InPlaceChat.loadTimeline()).rejects.toThrow('waiting for the owner to unlock');
  await expect(window.InPlaceChat.sendMessage('Private fallback must not happen')).rejects.toThrow('cannot send');
  expect(calls.some(call => call.url.startsWith('/api/user/messages'))).toBe(false);
});

test('an invited member refreshes stale pending capabilities after owner key activation', async () => {
  const { calls } = mount({ pending: true, activateOnRoom: true });
  const messages = await window.InPlaceChat.loadTimeline();
  expect(messages.map(message => message.content)).toEqual(['Welcome', 'Hello from Peer']);
  expect(calls.some(call => call.url === '/api/user/chat-threads/room-one')).toBe(true);
  expect(calls.some(call => call.url === '/api/user/shared/room-one/messages?after=0')).toBe(true);
  expect(calls.some(call => call.url.startsWith('/api/user/messages'))).toBe(false);
});

test('imported shared questions keep options and answer through the shared endpoint', async () => {
  const { calls } = mount({ includeQuestion: true });
  const before = await window.InPlaceChat.loadTimeline();
  expect(before[1]).toMatchObject({ type: 'agent_question', content: 'Choose a plan', options: expect.arrayContaining([expect.objectContaining({ optionId: 'option-yes', text: 'Yes' })]) });
  const after = await window.InPlaceChat.answerQuestion('question-one', { optionId: 'option-yes', text: 'Yes' });
  const answer = calls.find(call => call.url.endsWith('/questions/question-one/answer'));
  expect(answer).toBeDefined();
  expect(JSON.parse(answer.options.body).payload).toMatchObject({ text: 'Yes', optionId: 'option-yes' });
  expect(after.find(message => message.messageId === 'question-one').selectedOption).toBe('Yes');
  expect(after.at(-1)).toMatchObject({ type: 'user_message', content: 'Yes' });
  expect(calls.some(call => call.url === '/api/user/responses')).toBe(false);
});


test('a top scroll caused by initial chat rendering does not preload the private backlog', async () => {
  mount({ longHistory: true, scrollArea: true });
  const busy = jest.fn().mockReturnValue(true);
  window.DashboardHelpers = { chatHistoryBusy: busy, prependSharedHistory: jest.fn() };
  await window.InPlaceChat.loadTimeline();
  const area = document.getElementById('conversationArea');
  area.dispatchEvent(new Event('scroll'));
  expect(window.fetch.mock.calls.some(([url]) => String(url).includes('/messages?before=201&limit=200'))).toBe(false);
  busy.mockReturnValue(false);
  area.dispatchEvent(new Event('scroll'));
  await window.InPlaceChat.loadOlderTimeline();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(window.DashboardHelpers.prependSharedHistory).toHaveBeenCalledTimes(1);
  delete window.DashboardHelpers;
});

test('phone shared history opens with 30 messages and pages 50 more on demand', async () => {
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  try {
    const { messages } = mount({ longHistory: true });
    const originalFetch = window.fetch;
    window.fetch = jest.fn((url, options) => {
      const parsed = new URL(url, 'https://space.example');
      if (parsed.pathname.endsWith('/messages') && parsed.searchParams.has('before')) {
        const before = BigInt(parsed.searchParams.get('before'));
        return Promise.resolve(response(messages.filter(message => BigInt(message.seq) < before).slice(-Number(parsed.searchParams.get('limit')))));
      }
      return originalFetch(url, options);
    });
    const initial = await window.InPlaceChat.loadTimeline();
    expect(initial).toHaveLength(30);
    expect(initial[0].sharedSequence).toBe(371);
    expect(window.SharedCrypto.decrypt).toHaveBeenCalledTimes(30);
    const expanded = await window.InPlaceChat.loadOlderTimeline();
    expect(expanded).toHaveLength(80);
    expect(expanded[0].sharedSequence).toBe(321);
    expect(window.InPlaceChat.hasOlderMessages()).toBe(true);
  } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); }
});

test('a failed older page keeps the transcript and can retry at the top without a load button', async () => {
  mount({ longHistory: true, scrollArea: true });
  const errors = jest.fn(), render = jest.fn();
  window.DashboardHelpers = { sharedHistoryError: errors, prependSharedHistory: render };
  await window.InPlaceChat.loadTimeline();
  const fetcher = window.fetch;
  let fail = true;
  window.fetch = jest.fn((url, options) => {
    if (fail && String(url).includes('/messages?before=201&limit=200')) { fail = false; return Promise.resolve(response({}, 503)); }
    return fetcher(url, options);
  });
  const area = document.getElementById('conversationArea');
  area.innerHTML = '<p id="saved-transcript">Recent message</p>';
  area.dispatchEvent(new Event('scroll'));
  await expect(window.InPlaceChat.loadOlderTimeline()).rejects.toThrow();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(errors).toHaveBeenCalledWith(expect.stringContaining('try again'));
  expect(document.getElementById('saved-transcript')).not.toBeNull();
  area.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }));
  await window.InPlaceChat.loadOlderTimeline();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(render).toHaveBeenCalledTimes(1);
  delete window.DashboardHelpers;
});

test('phone owner history keeps a small first page and reaches older private rows through the same timeline', async () => {
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  try {
    mount();
    const original = window.fetch;
    window.fetch = jest.fn((url, options) => {
      if (String(url).includes('/messages?before=9223372036854775807&limit=30')) {
        return original(String(url).replace('limit=30', 'limit=200'), options);
      }
      if (String(url).includes('/owner-history?')) {
        const params = new URL(url, 'https://space.example').searchParams;
        const offset = Number(params.get('offset')), limit = Number(params.get('limit'));
        const page = Array.from({ length: Math.min(limit, 65 - offset) }, (_, index) => ({
          messageId: `private-${offset + index}`, type: 'user_message', timestamp: '2025-12-31',
          content: `Saved owner history ${offset + index}`, ownerPrivateHistory: true
        }));
        return Promise.resolve(response({ messages: page, nextOffset: offset + page.length,
          hasMore: offset + page.length < 65, boundary: '2026-01-01' }));
      }
      return original(url, options);
    });
    window.InPlaceChat.setContext({ ...context(), role: 'owner' });
    await window.InPlaceChat.loadTimeline();
    await new Promise(resolve => setTimeout(resolve, 0));
    const newest = await window.InPlaceChat.loadTimeline();
    expect(newest.filter(message => message.ownerPrivateHistory)).toHaveLength(30);
    const all = await window.InPlaceChat.loadOlderTimeline();
    expect(all.filter(message => message.ownerPrivateHistory)).toHaveLength(65);
    expect(all.some(message => message.messageId === 'private-64')).toBe(true);
    expect(window.InPlaceChat.hasOlderMessages()).toBe(false);
    const lastHistory = window.fetch.mock.calls.map(([url]) => String(url)).filter(url => url.includes('/owner-history?')).at(-1);
    const params = new URL(lastHistory, 'https://space.example').searchParams;
    expect(params.get('offset')).toBe('30');
    expect(params.get('boundary')).toBe('2026-01-01');
  } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); }
});
