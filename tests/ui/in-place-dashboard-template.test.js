const ejs = require('ejs');
const path = require('path');
const view = path.join(__dirname, '../../views/dashboard.ejs');
const layout = path.join(__dirname, '../../views/layout.ejs');
const originalFlags = {
  shared: process.env.FEATURE_SHARED_CONVERSATIONS,
  guest: process.env.FEATURE_GUEST_SHARING,
  inPlace: process.env.FEATURE_IN_PLACE_AGENT_SHARING
};
afterEach(() => {
  if (originalFlags.guest === undefined) delete process.env.FEATURE_GUEST_SHARING;
  else process.env.FEATURE_GUEST_SHARING = originalFlags.guest;
  if (originalFlags.shared === undefined) delete process.env.FEATURE_SHARED_CONVERSATIONS;
  else process.env.FEATURE_SHARED_CONVERSATIONS = originalFlags.shared;
  if (originalFlags.inPlace === undefined) delete process.env.FEATURE_IN_PLACE_AGENT_SHARING;
  else process.env.FEATURE_IN_PLACE_AGENT_SHARING = originalFlags.inPlace;
});
const locals = {
  agents: [], groups: [], encryptionSalt: '', isGoogleAuth: false,
  csrfToken: 'fixture', cspNonce: 'fixture',
  assetUrl: require('../../src/utils/assetUrl').assetUrl,
  safeJsonForScript: require('../../src/utils/safeJsonHelper').safeJsonForScript
};

test('legacy dashboard renders without a user local and keeps in-place UI/API module inactive when flags are off', async () => {
  delete process.env.FEATURE_SHARED_CONVERSATIONS;
  delete process.env.FEATURE_IN_PLACE_AGENT_SHARING;
  const html = await ejs.renderFile(view, locals);
  expect(html).toContain('data-user-id=""');
  expect(html).not.toContain('id="sharedConversationSection"');
  expect(html).not.toContain('/js/in-place-chat.js');
  expect(html).not.toContain('id="headerShareExistingChatBtn"');
  expect(html).not.toContain('/js/chat-history-import.js');
});

test('in-place dashboard shell is emitted only when both backend and dashboard flags are enabled', async () => {
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  const html = await ejs.renderFile(view, { ...locals, user: { userId: 'user-one', email: 'owner@example.test' } });
  expect(html).toContain('data-user-id="user-one"');
  expect(html).toContain('id="sharedConversationSection"');
  expect(html).toContain('/js/in-place-chat.js');
  expect(html).toContain('id="headerShareExistingChatBtn"');
  expect(html).toContain('id="shareExistingChatDialog"');
  expect(html).not.toContain('Earlier conversations and private history');
  expect(html).not.toContain('id="shareEarlierConversations"');
  expect(html).not.toContain('id="sharePrivateHistory"');
  expect(html).not.toContain('id="loadSharedOlderMessages"');
  expect(html).not.toContain('id="agentShareDialog"');
  expect(html).not.toContain('id="agentShareChatLink"');
  expect(html).toContain('/js/chat-history-import.js');
});

test('the explicit legacy view override reaches the included agent menu even when the global in-place flag is on', async () => {
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  const html = await ejs.renderFile(view, { ...locals, featureInPlaceAgentSharing: false });
  expect(html).toContain('id="agentShareDialog"');
  expect(html).not.toContain('id="shareExistingChatDialog"');
  expect(html).not.toContain('/js/in-place-chat.js');
});

test('legacy navigation remains available with the in-place flag off and disappears when it is on', async () => {
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_GUEST_SHARING = 'true';
  delete process.env.FEATURE_IN_PLACE_AGENT_SHARING;
  const locals = { title: 'Dashboard', user: { email: 'owner@example.test' }, body: '', cspNonce: 'test', assetUrl: require('../../src/utils/assetUrl').assetUrl };
  const legacy = await ejs.renderFile(layout, locals);
  expect(legacy).toContain('href="/shared"');
  expect(legacy).toContain('href="/guest-sharing"');

  process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  const inPlace = await ejs.renderFile(layout, locals);
  expect(inPlace).not.toContain('href="/shared"');
  expect(inPlace).not.toContain('href="/guest-sharing"');
});
