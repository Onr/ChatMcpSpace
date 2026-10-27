/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dashboard = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const renderSource = dashboard.slice(dashboard.indexOf('async function displayMessages('), dashboard.indexOf('function timeAgo('));

test('one ordinary chat renders guest identity and owner, selected and everyone audience badges safely', () => {
  document.body.innerHTML = '<div id="conversationArea"></div>';
  const escapeHtml = text => { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; };
  const sandbox = { document, window: {}, escapeHtml, renderMessageMarkdown: escapeHtml,
    formatTimestamp: () => '12:00', buildUserMessageReadIndicator: () => '', parseNewsMessage: () => null,
    selectedAgentType: 'standard', attachMessageTtsButton: () => {}, attachMessageInfoButton: () => {}, attachRunCommandTimestamp: () => {} };
  vm.runInNewContext(dashboard.slice(dashboard.indexOf('function renderSharedMessageInfo('), dashboard.indexOf('function attachRunCommandTimestamp(')), sandbox);
  const entries = [
    { messageId: 'guest', type: 'user_message', senderName: 'Ari', sharedSenderKind: 'guest', sharedAudienceLabel: 'Everyone', sharedAudienceMode: 'all' },
    { messageId: 'owner', type: 'agent_message', sharedAudienceLabel: 'Owner only' },
    { messageId: 'selected', type: 'agent_message', sharedAudienceLabel: 'Owner + <img src=x onerror=alert(1)>', sharedAudienceMode: 'selected' },
    { messageId: 'all', type: 'agent_message', sharedAudienceLabel: 'Everyone', sharedAudienceMode: 'all' },
    { messageId: 'private', type: 'user_message', ownerPrivateHistory: true, sharedAudienceLabel: 'Owner only · private history' }
  ];
  for (const entry of entries) document.getElementById('conversationArea').appendChild(sandbox.createMessageElement({ ...entry, content: 'Message body' }));
  expect(document.querySelectorAll('#conversationArea [data-message-id]')).toHaveLength(5);
  expect(document.querySelector('[data-shared-sender-kind="guest"]').textContent).toContain('Guest · Ari');
  expect(document.querySelectorAll('.shared-message-audience--owner')).toHaveLength(2);
  expect(document.querySelectorAll('.shared-message-audience--all')).toHaveLength(2);
  expect(document.querySelector('.shared-message-audience--selected').textContent).toBe('Visible to Owner + <img src=x onerror=alert(1)>');
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelectorAll('.shared-message-audience svg[aria-hidden="true"]')).toHaveLength(5);
  expect(document.querySelector('[data-message-id="guest"] .message-bubble').textContent).toContain('Guest · Ari');
  expect(document.querySelectorAll('.message-bubble .shared-message-audience')).toHaveLength(5);
  const visibility = document.querySelector('[data-message-id="guest"] details');
  visibility.querySelector('summary').click();
  expect(visibility.open).toBe(true);
  expect(visibility.textContent).toContain('Everyone with access to this conversation');
});

test('an ordinary chat times out even if its response body stalls, then permits a fresh request', async () => {
  jest.useFakeTimers();
  try {
    let signal;
    const sandbox = { AbortController, setTimeout, clearTimeout, readErrorPayload: jest.fn(), fetch: jest.fn(async (_url, options) => {
      signal = options.signal;
      return { ok: true, json: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) };
    }) };
    vm.runInNewContext(dashboard.slice(dashboard.indexOf('async function fetchConversationPayload('), dashboard.indexOf('function showConversationLoadRetry(')), sandbox);
    const pending = sandbox.fetchConversationPayload('/api/user/messages/agent');
    const rejection = expect(pending).rejects.toThrow('The connection is taking too long. Please try again.');
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(15001);
    await rejection;
    expect(signal.aborted).toBe(true);
    sandbox.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: ['ready'] }) });
    expect((await sandbox.fetchConversationPayload('/api/user/messages/agent')).data.messages).toEqual(['ready']);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('a slower full refresh cannot append a duplicate image after a newer refresh completes', async () => {
  document.body.innerHTML = '<div id="conversationArea"></div>';
  let release;
  const sandbox = {
    document, console, setTimeout, selectedAgentId: 'agent', selectedChatContext: { conversationId: 'room' },
    conversationRendersInFlight: 0, conversationRenderGeneration: 0, isStaleConversationLoad: () => false,
    encryptionKey: 'local-key', looksLikeEncryptedText: () => false,
    window: { E2EEncryption: { decryptMessage: () => new Promise(resolve => { release = resolve; }) } },
    revokeAllAttachmentUrls: () => {}, lastMessageTimestamp: null, lastMessageCursor: null,
    updateConversationMeta: () => {}, updateComposerState: () => {}, refreshVisibleAgentActionStats: () => {},
    forceScrollToBottomOnNextRender: false, forceScrollToBottomUntil: 0, agentScrollPositions: new Map(),
    scrollToBottom: () => {}, triggerConversationEnterIfScheduled: () => {},
    createMessageElement: message => {
      const element = document.createElement('div');
      element.dataset.messageId = message.messageId;
      element.appendChild(document.createElement('img'));
      return element;
    }
  };
  vm.runInNewContext(renderSource, sandbox);
  const older = sandbox.displayMessages([{ messageId: 'image', encrypted: true, content: 'iv:tag:data', timestamp: '2026-01-01' }], false, { conversationId: 'room' });
  await sandbox.displayMessages([{ messageId: 'image', content: 'already decrypted', timestamp: '2026-01-01' }], false, { conversationId: 'room' });
  release('caption');
  expect(await older).toBe(false);
  expect(document.querySelectorAll('[data-message-id="image"]')).toHaveLength(1);
  expect(document.querySelectorAll('img')).toHaveLength(1);
});

test('input events cannot re-enable Send during an in-flight message', () => {
  const source = dashboard.slice(dashboard.indexOf('function updateComposerState()'), dashboard.indexOf('function updateComposerState()') + dashboard.slice(dashboard.indexOf('function updateComposerState()')).indexOf('\nfunction ', 10));
  const sandbox = { openingChatSelection: null, isSendingMessage: true, userMessageInput: { value: 'new draft' }, userMessageSendButton: { disabled: false }, setSendButtonLabel: jest.fn() };
  vm.runInNewContext(source, sandbox);
  sandbox.updateComposerState();
  expect(sandbox.userMessageSendButton.disabled).toBe(true);
  expect(sandbox.setSendButtonLabel).toHaveBeenCalledWith('Sending...');
});

test.each([false, true])('a long render yields to phone input and keeps existing history stable (refresh=%s)', async (refresh) => {
  document.body.innerHTML = '<button id="tap">Tap</button><div id="conversationArea"></div>';
  const area = document.getElementById('conversationArea');
  if (refresh) {
    area.innerHTML = '<div data-message-id="existing">Previous history</div>';
    area.scrollTop = 600;
  }
  let resume, clock = 0;
  class RenderClock extends Date { static now() { clock += 10; return clock; } }
  const sandbox = {
    Date: RenderClock, document, console, selectedAgentId: 'agent', selectedChatContext: { conversationId: 'room' },
    conversationRendersInFlight: 0, conversationRenderGeneration: 0, isStaleConversationLoad: () => false,
    encryptionKey: null, looksLikeEncryptedText: () => false,
    window: { requestAnimationFrame: () => { throw new Error('A throttled frame must not block transcript rendering'); } },
    setTimeout: callback => { if (!resume) resume = callback; else callback(); },
    revokeAllAttachmentUrls: () => {}, lastMessageTimestamp: null, lastMessageCursor: null,
    updateConversationMeta: () => {}, updateComposerState: () => {}, refreshVisibleAgentActionStats: () => {},
    forceScrollToBottomOnNextRender: false, forceScrollToBottomUntil: 0, agentScrollPositions: new Map(),
    scrollToBottom: () => {}, triggerConversationEnterIfScheduled: () => {},
    createMessageElement: message => {
      const element = document.createElement('div'); element.dataset.messageId = message.messageId; return element;
    }
  };
  vm.runInNewContext(renderSource, sandbox);
  const rendering = sandbox.displayMessages(Array.from({ length: 30 }, (_, i) => ({ messageId: `message-${i}`, timestamp: '2026-01-01' })), false, { conversationId: 'room' });
  expect(area.lastChild.dataset.messageId).toBe(refresh ? 'existing' : 'message-29');
  if (refresh) expect(area.scrollTop).toBe(600);
  const tapped = jest.fn(); document.getElementById('tap').onclick = tapped;
  document.getElementById('tap').click(); expect(tapped).toHaveBeenCalledTimes(1);
  resume(); await rendering;
  expect([...document.querySelectorAll('[data-message-id]')].map(element => element.dataset.messageId))
    .toEqual(Array.from({ length: 30 }, (_, i) => `message-${i}`));
});

test('a mobile tap opens the chat shell immediately and gives a retry if lookup fails', async () => {
  document.body.innerHTML = '<div id="agentPanelPlaceholder"></div><div id="conversationArea" class="hidden"></div>';
  let fail;
  const start = dashboard.indexOf('async function selectAgent(');
  const end = dashboard.indexOf('\nfunction ', start);
  const sandbox = { document, console, sharedChatSelectionRequest: 0, openingChatSelection: null,
    activeConversationLoadToken: 0, conversationRendersInFlight: 0, conversationRenderGeneration: 0,
    window: { InPlaceChat: { resolveAgentContext: () => new Promise((_resolve, reject) => { fail = reject; }) } },
    isMobileListOnlyMode: () => true, stopMessagePolling: jest.fn(), setMobileListExpanded: jest.fn(),
    updateComposerState: jest.fn(), escapeHtml: text => text, showErrorMessage: jest.fn() };
  vm.runInNewContext(dashboard.slice(start, end), sandbox);
  const opening = sandbox.selectAgent('agent', 'Mira');
  expect(document.getElementById('conversationArea').textContent).toContain('Opening Mira');
  expect(document.getElementById('conversationArea').classList.contains('hidden')).toBe(false);
  expect(sandbox.setMobileListExpanded).toHaveBeenCalledWith(false, { skipBrowserHistory: true });
  fail(new Error('Connection timed out')); await opening;
  expect(document.querySelector('[data-retry-open-chat]').textContent).toBe('Try again');
  expect(sandbox.openingChatSelection).toBeNull();
});
