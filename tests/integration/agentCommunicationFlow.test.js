const express = require('express');
const request = require('supertest');

const { createTestDatabase, applyRuntimeUserColumns, seedUser, applyArchiveSchema } = require('../utils/pgMemTestUtils');

async function createIntegrationContext() {
  jest.resetModules();

  const { pool, query } = createTestDatabase();
  await applyRuntimeUserColumns(query);
  await applyArchiveSchema(query);
  const { userId } = await seedUser(query);

  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => query(text, params),
    getClient: () => pool.connect(),
    pool,
  }));

  jest.doMock('../../src/utils/securityLogger', () => ({
    logUnauthorizedAccess: jest.fn(),
    logApiKeyUsage: jest.fn(),
    logRateLimitViolation: jest.fn(),
  }));

  jest.doMock('../../src/utils/logger', () => ({
    logInfo: jest.fn(),
    logWarn: jest.fn(),
    logError: jest.fn(),
  }));

  jest.doMock('../../src/middleware/authMiddleware', () => {
    const actual = jest.requireActual('../../src/middleware/authMiddleware');
    return {
      ...actual,
      requireApiKey: (req, _res, next) => {
        req.user = { userId };
        next();
      },
    };
  });

  jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
    userPollingRateLimiter: (_req, _res, next) => next(),
    agentPollingRateLimiter: (_req, _res, next) => next(),
    agentApiRateLimiter: (_req, _res, next) => next(),
    feedbackRateLimiter: (_req, _res, next) => next(),
  }));

  jest.doMock('../../src/services/ttsService', () => ({
    getAudioUrl: jest.fn().mockResolvedValue(null),
  }));

  const agentApiRoutes = require('../../src/routes/agentApiRoutes');
  const userApiRoutes = require('../../src/routes/userApiRoutes');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId };
    next();
  });
  app.use('/api/agent', agentApiRoutes);
  app.use('/api/user', userApiRoutes);

  return { app, query, pool, userId };
}

describe('Integration: agent communication flow', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('agent -> user -> agent roundtrip works', async () => {
    const { app, pool } = await createIntegrationContext();

    await request(app)
      .post('/api/agent/messages')
      .send({ agentName: 'FlowAgent', content: 'hello user', priority: 0 })
      .expect(201);

    const agentsRes = await request(app).get('/api/user/agents').expect(200);
    const flowAgent = agentsRes.body.agents.find((a) => a.name === 'FlowAgent');
    expect(flowAgent).toBeTruthy();

    const userMsg = await request(app)
      .post('/api/user/messages')
      .send({ agentId: flowAgent.agentId, content: 'hello agent' })
      .expect(201);
    expect(userMsg.body.messageId).toBeTruthy();

    const responses = await request(app).get('/api/agent/responses').query({ agentName: 'FlowAgent' }).expect(200);
    expect(responses.body.responses.some((r) => r.responseType === 'text' && r.content === 'hello agent')).toBe(true);

    await pool.end();
  });
});

