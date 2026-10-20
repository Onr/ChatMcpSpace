/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const script = fs.readFileSync(path.join(__dirname, '../../public/js/in-place-chat.js'), 'utf8');
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const owner = id => ({ conversationId: id, agentId: 'agent', agentName: 'AgentsMCPspace', mode: 'shared', role: 'owner' });

function mount({ keys = [{ key_version: 2, wrapped_key: 'existing-key' }], pages = [[]], conflict = false, pendingMembers = true } = {}) {
  document.body.innerHTML = '<div id="dashboardRoot" data-user-id="owner"></div><section id="sharedConversationSection"><div id="sharedConversationList"></div><div id="incomingSharingInvitations"></div></section><aside id="sharingAccessNotice" hidden><p id="sharingAccessNoticeText"></p><button id="sharingAccessUnlock"></button><button id="sharingAccessRetry"></button></aside>';
  window.getStoredEncryptionKey = jest.fn().mockResolvedValue('owner-local-key');
  window.SharedCrypto = {
    privateKey: jest.fn().mockResolvedValue('owner-private-key'),
    unwrap: jest.fn(async wrapped => wrapped), wrap: jest.fn(async key => key),
    newKey: jest.fn().mockResolvedValue('locally-generated-key'),
    encrypt: jest.fn(async (key, value) => ({ key, value }))
  };
  let pending = pendingMembers;
  let attempts = 0;
  const contexts = [owner('legacy-one'), owner('legacy-two'), owner('legacy-three'),
    { conversationId: 'recipient-room', mode: 'shared', role: 'participant', membershipStatus: 'active', agentName: 'A colleague' }];
  window.fetch = jest.fn(async (url, options = {}) => {
    if (url === '/api/user/chat-threads') return response(contexts);
    if (url === '/api/user/chat-threads/invitations/incoming') return response([]);
    if (url === '/api/user/shared/identity') return response({ private_key: {} });
    if (url.endsWith('/keys')) {
      attempts++;
      if (conflict && attempts === 1) return response({ error: { message: 'Membership or key changed; refresh before provisioning' } }, 409);
      pending = false;
      if (!keys.length) keys = [{ key_version: 2, wrapped_key: 'server-accepted-key' }];
      return response({ keyVersion: 2 });
    }
    if (url.includes('/messages?after=')) return response(url.endsWith('after=0') ? pages[0] : pages[1] || []);
    if (url.startsWith('/api/user/shared/')) return response({
      room: { key_version: 2, membership_version: pending ? 2 : 3, rotation_required: false, agent_id: 'agent', member: { role: 'owner', status: 'active' } },
      keys,
      members: [{ user_id: 'owner', status: 'active', public_key: {} }, { user_id: 'invitee', status: pending ? 'pending' : 'active', public_key: {} }],
      agentIdentity: { public_key: {} }
    });
    throw new Error('Unexpected request: ' + url);
  });
  window.eval(script);
  window.InPlaceChat.setContext({ mode: 'private', conversationId: 'ordinary-chat', agentId: 'another-agent' });
  return { contexts, attempts: () => attempts, isPending: () => pending };
}

test('owner in a different private chat activates the invitee without switching chats or sharing a local password', async () => {
  const fixture = mount();
  const results = await window.InPlaceChat.maintainOwnedAccess([owner('room')]);
  expect(results[0].status).toBe('fulfilled');
  expect(fixture.isPending()).toBe(false);
  expect(window.InPlaceChat.getContext()).toMatchObject({ mode: 'private', conversationId: 'ordinary-chat' });
  const post = window.fetch.mock.calls.find(([url]) => url.endsWith('/keys'));
  expect(JSON.parse(post[1].body).envelopes).toContainEqual({ principal: 'user:invitee', keyVersion: 2, wrappedKey: 'existing-key' });
  expect(post[1].body).not.toContain('owner-local-key');
  expect(post[1].body).not.toContain('owner-private-key');
});

test('a locked owner gets an actionable notice and a local unlock activates the waiting participant', async () => {
  const fixture = mount();
  window.getStoredEncryptionKey.mockResolvedValue(null);
  const unlockEncryption = jest.fn();
  window.DashboardHelpers = { getEncryptionKey: () => null, unlockEncryption };
  const [locked] = await window.InPlaceChat.maintainOwnedAccess([owner('room')]);
  expect(locked.status).toBe('rejected');
  expect(locked.reason.code).toBe('ENCRYPTION_LOCKED');
  expect(document.getElementById('sharingAccessNotice').hidden).toBe(false);
  expect(document.getElementById('sharingAccessNoticeText').textContent).toContain('Unlock your account encryption locally');
  document.getElementById('sharingAccessUnlock').click();
  expect(unlockEncryption).toHaveBeenCalledTimes(1);
  expect(fixture.isPending()).toBe(true);
  window.getStoredEncryptionKey.mockResolvedValue('owner-local-key');
  const [activated] = await window.InPlaceChat.maintainOwnedAccess([owner('room')]);
  expect(activated.status).toBe('fulfilled');
  expect(fixture.isPending()).toBe(false);
  expect(document.getElementById('sharingAccessNotice').hidden).toBe(true);
  expect(window.InPlaceChat.getContext().conversationId).toBe('ordinary-chat');
});

test('healthy rooms require no owner unlock, while wrong local passwords show a retryable explanation', async () => {
  mount({ pendingMembers: false });
  window.getStoredEncryptionKey.mockResolvedValue(null);
  await window.InPlaceChat.maintainOwnedAccess([owner('room')]);
  expect(window.getStoredEncryptionKey).not.toHaveBeenCalled();
  expect(document.getElementById('sharingAccessNotice').hidden).toBe(true);
  mount();
  window.SharedCrypto.privateKey.mockRejectedValue(new Error('OperationError'));
  const [result] = await window.InPlaceChat.maintainOwnedAccess([owner('room')]);
  expect(result.reason.message).toContain('account encryption password used to set up sharing');
  expect(document.getElementById('sharingAccessUnlock').hidden).toBe(false);
});

test('one broken room does not prevent another room from admitting a participant', async () => {
  const fixture = mount();
  const fetch = window.fetch;
  window.fetch = jest.fn(async (url, options) => {
    if (url === '/api/user/shared/broken') return response({ error: { message: 'Conversation unavailable' } }, 404);
    return fetch(url, options);
  });
  const results = await window.InPlaceChat.maintainOwnedAccess([owner('broken'), owner('room')]);
  expect(results.map(item => item.status)).toEqual(['rejected', 'fulfilled']);
  expect(fixture.isPending()).toBe(false);
  expect(document.getElementById('sharingAccessNoticeText').textContent).toContain('Conversation unavailable');
  expect(document.getElementById('sharingAccessUnlock').hidden).toBe(true);
});

test('access maintenance and the unlock listener start before ordinary chat restoration is ready', async () => {
  const start = script.indexOf("root.addEventListener('load', async () => {");
  const end = script.indexOf('    const conversationId =', start);
  const body = script.slice(start + "root.addEventListener('load', async () => {".length, end);
  const listeners = new Map();
  const root = { dashboardReady: false, setInterval: jest.fn().mockReturnValue(1), clearInterval: jest.fn(),
    addEventListener: (name, callback) => listeners.set(name, callback) };
  const refreshList = jest.fn().mockResolvedValue(undefined);
  const startMaintenance = new Function('root', 'document', 'refreshList', 'contextEpoch', `return (async () => {${body}})();`);
  const pendingStartup = startMaintenance(root, document, refreshList, 0);
  expect(root.setInterval).toHaveBeenCalledWith(expect.any(Function), 5000);
  expect(refreshList).toHaveBeenCalledTimes(1);
  listeners.get('encryption:unlocked')();
  expect(refreshList).toHaveBeenCalledTimes(2);
  listeners.get('dashboard:ready')();
  await pendingStartup;
});

test('owned legacy rooms do not duplicate the ordinary agent list, and polling preserves focused recipient rows', async () => {
  mount();
  await window.InPlaceChat.refreshList();
  const list = document.getElementById('sharedConversationList');
  expect(list.children).toHaveLength(1);
  expect(list.textContent).toContain('A colleague');
  expect(list.textContent).not.toContain('Shared by you');
  const button = list.querySelector('button');
  button.focus();
  await window.InPlaceChat.refreshList();
  expect(list.querySelector('button')).toBe(button);
  expect(document.activeElement).toBe(button);
});

test('an older unaccepted invitation still has an explicit Join action in the ordinary chat list', async () => {
  const fixture = mount();
  const invite = { conversationId: 'recipient-room', agentId: 'agent', mode: 'shared', role: 'participant', membershipStatus: 'invited', agentName: 'A colleague' };
  fixture.contexts.splice(0, fixture.contexts.length, invite);
  const fetch = window.fetch;
  window.fetch = jest.fn(async (url, options) => {
    if (url.endsWith('/recipient-room/accept')) {
      invite.membershipStatus = 'pending';
      return response({ status: 'pending' });
    }
    if (url === '/api/user/chat-threads/recipient-room') return response(invite);
    return fetch(url, options);
  });
  const selectChatContext = jest.fn();
  window.DashboardHelpers = { selectChatContext };
  await window.InPlaceChat.refreshList();
  const button = document.querySelector('#sharedConversationList button');
  expect(button.getAttribute('aria-label')).toBe('Join A colleague shared conversation');
  button.click();
  for (let i = 0; i < 20 && !selectChatContext.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(window.fetch).toHaveBeenCalledWith('/api/user/shared/recipient-room/accept', expect.objectContaining({ method: 'POST' }));
  expect(selectChatContext).toHaveBeenCalledWith(invite);
  window.history.replaceState({}, '', '/');
});

test('provisioning omits obsolete versions that no longer have retained messages', async () => {
  mount({ keys: [{ key_version: 1, wrapped_key: 'old-key' }, { key_version: 2, wrapped_key: 'existing-key' }],
    pages: [[{ seq: 1, key_version: 1, deleted_at: '2026-10-10' }, { seq: 2, key_version: 2 }]] });
  const [result] = await window.InPlaceChat.maintainOwnedAccess([owner('room')]);
  expect(result.status).toBe('fulfilled');
  const post = window.fetch.mock.calls.find(([url]) => url.endsWith('/keys'));
  expect(JSON.parse(post[1].body).envelopes.every(envelope => envelope.keyVersion === 2)).toBe(true);
});

test('all history pages are checked before activating a new participant', async () => {
  mount({ pages: [Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, key_version: 2 })), [{ seq: 201, key_version: 1 }]] });
  const [result] = await window.InPlaceChat.maintainOwnedAccess([owner('room')]);
  expect(result.status).toBe('rejected');
  expect(result.reason.message).toContain('retained history');
  expect(window.fetch.mock.calls.some(([url]) => url.endsWith('after=200'))).toBe(true);
  expect(window.fetch.mock.calls.some(([url]) => url.endsWith('/keys'))).toBe(false);
});

test('a changed membership snapshot is refreshed and retried instead of leaving the invitee pending', async () => {
  const fixture = mount({ conflict: true });
  const [result] = await window.InPlaceChat.maintainOwnedAccess([owner('room')]);
  expect(result.status).toBe('fulfilled');
  expect(fixture.attempts()).toBe(2);
  expect(fixture.isPending()).toBe(false);
});

test('concurrent background checks share one operation and use server accepted envelopes after initial setup', async () => {
  const fixture = mount({ keys: [] });
  await Promise.all([window.InPlaceChat.maintainOwnedAccess([owner('room')]), window.InPlaceChat.maintainOwnedAccess([owner('room')])]);
  expect(fixture.attempts()).toBe(1);
  expect(await window.InPlaceChat.encryptImportedPayload('room', { text: 'hello' }, 2)).toMatchObject({ key: 'server-accepted-key' });
});

test('the first successful poll clears pending access even when the shared conversation has no messages', async () => {
  const vm = require('vm');
  const dashboard = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
  const start = dashboard.indexOf('async function pollMessages(agentId) {');
  const end = dashboard.indexOf('\n  if (isStaleConversationLoad(agentId, null))', start);
  const displayMessages = jest.fn();
  const loadTimeline = jest.fn().mockRejectedValueOnce(new Error('Waiting for an owner')).mockResolvedValue([]);
  const scope = {
    isLoadingMessages: false,
    isLoadingOlderMessages: false,
    activeConversationLoadToken: 1,
    selectedChatContext: { mode: 'shared', conversationId: 'room', agentId: 'agent' },
    window: { InPlaceChat: { loadTimeline } },
    conversationCache: new Map(),
    liveRefreshScrollOptions: () => ({}),
    isStaleConversationLoad: () => false,
    displayMessages,
    console: { warn: jest.fn() }
  };
  vm.createContext(scope);
  vm.runInContext(dashboard.slice(start, end) + '\n}', scope);
  await scope.pollMessages('agent');
  expect(displayMessages).not.toHaveBeenCalled();
  await scope.pollMessages('agent');
  expect(displayMessages).toHaveBeenCalledWith([], false, { agentId: 'agent', conversationId: 'room', requestToken: 1 });
});

test('access activation updates the composer and participant count while preserving a different selected room', () => {
  const vm = require('vm');
  const parser = require('@babel/parser');
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
  const assignment = parser.parse(source).program.body.find(node => node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' && node.expression.left.object?.name === 'window' && node.expression.left.property?.name === 'DashboardHelpers');
  const handler = assignment.expression.right.properties.find(property => property.key.name === 'refreshSelectedChatContext').value;
  document.body.innerHTML = '<button id="selectedChatContextStatus" hidden><svg aria-hidden="true"></svg><span data-shared-participant-count></span></button>';
  const icon = document.querySelector('#selectedChatContextStatus svg');
  const context = { mode: 'shared', conversationId: 'room', role: 'participant', capabilities: { send: true } };
  const scope = { selectedChatContext: { ...context, capabilities: { send: false } }, updateComposerState: jest.fn(), document };
  vm.createContext(scope);
  const control = parser.parse(source).program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'updateSharedChatControl');
  vm.runInContext(source.slice(control.start, control.end), scope);
  vm.runInContext('refresh = ' + source.slice(handler.start, handler.end), scope);
  scope.refresh(context, { members: [{ status: 'active' }, { status: 'active' }, { status: 'pending' }], guests: [{ status: 'active' }, { status: 'removed' }] });
  expect(scope.selectedChatContext.capabilities.send).toBe(true);
  expect(scope.updateComposerState).toHaveBeenCalledTimes(1);
  const button = document.getElementById('selectedChatContextStatus');
  expect(button.textContent).toBe('3');
  expect(button.hidden).toBe(false);
  expect(button.getAttribute('aria-label')).toBe('View people and sharing · 3 people');
  expect(button.querySelector('svg')).toBe(icon);
  scope.selectedChatContext = { ...context, conversationId: 'different-room' };
  scope.refresh(context, { members: [{ status: 'active' }] });
  expect(scope.selectedChatContext.conversationId).toBe('different-room');
  expect(scope.updateComposerState).toHaveBeenCalledTimes(1);
  expect(button.textContent).toBe('3');
  scope.updateSharedChatControl({ ...context, role: 'owner' }, { members: [{ status: 'active' }] });
  expect(button.getAttribute('aria-label')).toBe('Manage sharing · 1 person');
  scope.updateSharedChatControl(null);
  expect(button.hidden).toBe(true);
});
