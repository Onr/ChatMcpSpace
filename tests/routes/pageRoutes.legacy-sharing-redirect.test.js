const express = require('express');
const request = require('supertest');

const originalFlags = {
  shared: process.env.FEATURE_SHARED_CONVERSATIONS,
  guests: process.env.FEATURE_GUEST_SHARING,
  inPlace: process.env.FEATURE_IN_PLACE_AGENT_SHARING
};

function restoreFlags() {
  for (const [key, value] of [
    ['FEATURE_SHARED_CONVERSATIONS', originalFlags.shared],
    ['FEATURE_GUEST_SHARING', originalFlags.guests],
    ['FEATURE_IN_PLACE_AGENT_SHARING', originalFlags.inPlace]
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function buildApp(threadService, { ownedAgents = [] } = {}) {
  jest.resetModules();
  jest.doMock('passport', () => ({ authenticate: () => (_req, _res, next) => next() }));
  jest.doMock('../../src/services/authService', () => ({}));
  jest.doMock('../../src/services/mfaService', () => ({}));
  jest.doMock('../../src/services/emailService', () => ({}));
  jest.doMock('../../src/middleware/authMiddleware', () => ({
    protectRoute: (req, _res, next) => { req.user = { userId: '11111111-1111-4111-8111-111111111111' }; next(); }
  }));
  jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({ authRateLimiter: (_req, _res, next) => next() }));
  jest.doMock('../../src/middleware/csrfMiddleware', () => ({ csrfProtection: (_req, _res, next) => next(), validateCsrfToken: (_req, _res, next) => next() }));
  jest.doMock('../../src/utils/securityLogger', () => ({ logAuthenticationFailure: jest.fn() }));
  jest.doMock('../../src/db/connection', () => ({
    query: jest.fn().mockResolvedValue({ rows: ownedAgents.map(agentId => ({ agent_id: agentId })) })
  }));
  jest.doMock('../../src/utils/validation', () => ({}));
  jest.doMock('../../src/utils/apiGuideGenerator', () => ({}));
  jest.doMock('../../src/utils/encryptionHelper', () => ({}));
  jest.doMock('../../src/utils/localMode', () => ({ isLocalAuthMode: () => false }));
  jest.doMock('../../src/utils/modelCatalog', () => ({}));
  jest.doMock('../../src/utils/agentStopUtils', () => ({}));
  jest.doMock('../../src/services/agentRuntimeConfigService', () => ({}));
  jest.doMock('../../public/js/marble-generator', () => ({}));
  jest.doMock('../../src/shared/chatThreadService', () => threadService);

  const app = express();
  app.use((req, _res, next) => { req.session = {}; next(); });
  app.use((req, res, next) => {
    res.locals.csrfToken = 'test';
    res.render = (view, locals) => res.status(200).json({ view, ...locals });
    next();
  });
  app.use(require('../../src/routes/pageRoutes'));
  return app;
}

afterEach(() => {
  restoreFlags();
  jest.resetModules();
  jest.clearAllMocks();
});

test.each(['conversationId', 'roomId', 'id'])('redirects legacy /shared %s deep links into the in-place dashboard', async param => {
  process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  const room = '22222222-2222-4222-8222-222222222222';
  const getChatContext = jest.fn().mockResolvedValue({ conversationId: room });
  const app = buildApp({ getChatContext, listChatThreads: jest.fn(), resolveAgentThread: jest.fn() });
  await request(app).get('/shared').query({ [param]: room }).expect(302).expect('Location', `/dashboard?conversationId=${room}`);
  expect(getChatContext).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', room);
});

test('redirects a legacy guest-sharing agent link to its accessible ordinary chat', async () => {
  process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_GUEST_SHARING = 'true';
  const agentId = '33333333-3333-4333-8333-333333333333';
  const room = '44444444-4444-4444-8444-444444444444';
  const listChatThreads = jest.fn().mockResolvedValue([{ agentId, conversationId: room, role: 'participant', membershipStatus: 'active' }]);
  const app = buildApp({ getChatContext: jest.fn(), listChatThreads, resolveAgentThread: jest.fn() });
  await request(app).get('/guest-sharing').query({ agentId }).expect(302).expect('Location', `/dashboard?conversationId=${room}`);
  expect(listChatThreads).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
});

test('resolves an owned legacy agent link to its primary dashboard thread', async () => {
  process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  const agentId = '55555555-5555-4555-8555-555555555555';
  const room = '66666666-6666-4666-8666-666666666666';
  const resolveAgentThread = jest.fn().mockResolvedValue({ conversationId: room });
  const listChatThreads = jest.fn();
  const app = buildApp({ getChatContext: jest.fn(), listChatThreads, resolveAgentThread }, { ownedAgents: [agentId] });
  await request(app).get('/shared').query({ agentId }).expect(302).expect('Location', `/dashboard?conversationId=${room}`);
  expect(resolveAgentThread).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', agentId);
  expect(listChatThreads).not.toHaveBeenCalled();
});

test('ignores malformed and inaccessible legacy identifiers and falls back to dashboard', async () => {
  process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  const getChatContext = jest.fn().mockRejectedValue(new Error('Conversation not found'));
  const app = buildApp({ getChatContext, listChatThreads: jest.fn().mockResolvedValue([]), resolveAgentThread: jest.fn().mockRejectedValue(new Error('Agent not found')) });
  await request(app).get('/shared').query({ roomId: 'not-a-uuid', agentId: 'not-a-uuid' }).expect(302).expect('Location', '/dashboard');
  expect(getChatContext).not.toHaveBeenCalled();
});

test.each([
  ['/shared', 'shared'],
  ['/guest-sharing', 'guest-sharing']
])('keeps legacy %s rendering intact when in-place sharing is off', async (path, view) => {
  delete process.env.FEATURE_IN_PLACE_AGENT_SHARING;
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_GUEST_SHARING = 'true';
  const app = buildApp({});
  const response = await request(app).get(path).expect(200);
  expect(response.body.view).toBe(view);
});
