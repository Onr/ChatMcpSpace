const fs = require('fs');
const path = require('path');

describe('chat switching stale render guards', () => {
  const jsPath = path.join(__dirname, '../../public/js/dashboard.js');
  const js = fs.readFileSync(jsPath, 'utf8');

  it('increments the active conversation token before rendering cached messages for a selected chat', () => {
    expect(js).toMatch(/const loadToken = \+\+activeConversationLoadToken;[\s\S]*?await displayMessages\(conversationCache\.get\(conversationCacheKey\), false, \{ agentId, requestToken: loadToken, conversationId: selectedConversationId \}\);/);
    expect(js).toMatch(/await displayMessages\(conversationCache\.get\(conversationCacheKey\), false, \{ agentId, requestToken: loadToken, conversationId: selectedConversationId \}\);[\s\S]*?if \(isStaleConversationLoad\(agentId, loadToken\)\) \{\s*return;\s*\}/);
  });

  it('passes agent identity and request token through all full conversation renders', () => {
    expect(js).toMatch(/await displayMessages\(cachedMessages, false, \{ agentId, requestToken \}\);/);
    expect(js).toMatch(/await displayMessages\(data\.messages, false, \{ agentId, requestToken \}\);/);
    expect(js).toMatch(/displayMessages\(newMessages, true, \{ agentId \}\);/);
  });

  it('rejects stale conversation renders before touching the message DOM', () => {
    expect(js).toMatch(/async function displayMessages\(messages, append = false, context = \{\}\)/);
    expect(js).toMatch(/const renderAgentId = context\.agentId \|\| selectedAgentId;/);
    expect(js).toMatch(/const isRenderStale = \(\) => isStaleConversationLoad\(renderAgentId, renderRequestToken\)/);
    expect(js).toMatch(/if \(isRenderStale\(\)\) \{\s*return false;\s*\}/);
  });

  it('ignores in-flight polling and read-status responses after the user switches chats', () => {
    expect(js).toMatch(/async function pollMessages\(agentId\)[\s\S]*?if \(isStaleConversationLoad\(agentId, null\)\) \{\s*return;\s*\}[\s\S]*?const response = await fetch\(url\);[\s\S]*?if \(isStaleConversationLoad\(agentId, null\)\) \{\s*return;\s*\}/);
    expect(js).toMatch(/async function pollReadStatus\(agentId\)[\s\S]*?if \(isStaleConversationLoad\(agentId, null\)\) \{\s*return;\s*\}/);
  });

  it('keeps guest history when an older shared poll finishes after switching away and back', async () => {
    let resolveTimeline;
    const guestHistory = [{ messageId: 'guest-reply', content: 'Guest message' }];
    const sandbox = {
      isLoadingMessages: false, isLoadingOlderMessages: false, activeConversationLoadToken: 1,
      selectedChatContext: { mode: 'shared', agentId: 'agent', conversationId: 'room' },
      conversationCache: new Map([['room', guestHistory]]), displayMessages: jest.fn(), console,
      window: { InPlaceChat: { loadTimeline: () => new Promise(resolve => { resolveTimeline = resolve; }) } }
    };
    sandbox.isStaleConversationLoad = (_agentId, token) => token !== null && token !== sandbox.activeConversationLoadToken;
    const source = js.slice(js.indexOf('async function pollMessages(agentId)'), js.indexOf('function buildUserMessageReadIndicator'));
    require('vm').runInNewContext(source, sandbox);
    const polling = sandbox.pollMessages('agent');
    sandbox.activeConversationLoadToken = 3;
    // The transport discards the old request after its context changes.
    resolveTimeline([]);
    await polling;
    expect(sandbox.conversationCache.get('room')).toBe(guestHistory);
    expect(sandbox.displayMessages).not.toHaveBeenCalled();
  });
});

test('a poll already in flight cannot reset the viewport when older history starts loading', async () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../../public/js/dashboard.js'), 'utf8');
  let release;
  const messages = [{ messageId: 'recent', content: 'Recent message' }];
  const scope = {
    isLoadingMessages: false, isLoadingOlderMessages: false, activeConversationLoadToken: 1,
    selectedChatContext: { mode: 'shared', agentId: 'agent', conversationId: 'room' },
    conversationCache: new Map([['room', messages]]), displayMessages: jest.fn(), console,
    window: { InPlaceChat: { loadTimeline: () => new Promise(resolve => { release = resolve; }) } },
    isStaleConversationLoad: () => false
  };
  const start = source.indexOf('async function pollMessages(agentId)'), end = source.indexOf('function buildUserMessageReadIndicator', start);
  require('vm').runInNewContext(source.slice(start, end), scope);
  const polling = scope.pollMessages('agent');
  scope.isLoadingOlderMessages = true;
  release([...messages, { messageId: 'newest' }]);
  await polling;
  expect(scope.displayMessages).not.toHaveBeenCalled();
  expect(scope.conversationCache.get('room')).toBe(messages);
});
