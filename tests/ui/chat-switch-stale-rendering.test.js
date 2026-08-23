const fs = require('fs');
const path = require('path');

describe('chat switching stale render guards', () => {
  const jsPath = path.join(__dirname, '../../public/js/dashboard.js');
  const js = fs.readFileSync(jsPath, 'utf8');

  it('increments the active conversation token before rendering cached messages for a selected chat', () => {
    expect(js).toMatch(/const loadToken = \+\+activeConversationLoadToken;[\s\S]*?await displayMessages\(conversationCache\.get\(agentId\), false, \{ agentId, requestToken: loadToken \}\);/);
    expect(js).toMatch(/await displayMessages\(conversationCache\.get\(agentId\), false, \{ agentId, requestToken: loadToken \}\);[\s\S]*?if \(isStaleConversationLoad\(agentId, loadToken\)\) \{\s*return;\s*\}/);
  });

  it('passes agent identity and request token through all full conversation renders', () => {
    expect(js).toMatch(/await displayMessages\(cachedMessages, false, \{ agentId, requestToken \}\);/);
    expect(js).toMatch(/await displayMessages\(data\.messages, false, \{ agentId, requestToken \}\);/);
    expect(js).toMatch(/displayMessages\(newMessages, true, \{ agentId \}\);/);
  });

  it('rejects stale conversation renders before touching the message DOM', () => {
    expect(js).toMatch(/async function displayMessages\(messages, append = false, context = \{\}\)/);
    expect(js).toMatch(/const renderAgentId = context\.agentId \|\| selectedAgentId;/);
    expect(js).toMatch(/const isRenderStale = \(\) => isStaleConversationLoad\(renderAgentId, renderRequestToken\);/);
    expect(js).toMatch(/if \(isRenderStale\(\)\) \{\s*return false;\s*\}/);
  });

  it('ignores in-flight polling and read-status responses after the user switches chats', () => {
    expect(js).toMatch(/async function pollMessages\(agentId\)[\s\S]*?if \(isStaleConversationLoad\(agentId, null\)\) \{\s*return;\s*\}[\s\S]*?const response = await fetch\(url\);[\s\S]*?if \(isStaleConversationLoad\(agentId, null\)\) \{\s*return;\s*\}/);
    expect(js).toMatch(/async function pollReadStatus\(agentId\)[\s\S]*?if \(isStaleConversationLoad\(agentId, null\)\) \{\s*return;\s*\}/);
  });
});
