const express = require('express');
const request = require('supertest');

const { createTestDatabase, applyRuntimeUserColumns, seedUser, applyArchiveSchema } = require('../utils/pgMemTestUtils');

async function createContext() {
  jest.resetModules();

  const { pool, query } = createTestDatabase();
  await applyRuntimeUserColumns(query);
  await applyArchiveSchema(query);
  const { userId } = await seedUser(query);

  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => query(text, params),
    getClient: () => pool.connect(),
    pool
  }));

  jest.doMock('../../src/utils/securityLogger', () => ({
    logApiKeyUsage: jest.fn(),
    logRateLimitViolation: jest.fn()
  }));

  // Force the in-memory fallback for deterministic tests.
  jest.doMock('../../src/utils/redisClient', () => ({
    rateLimitRedisClient: null
  }));

  jest.doMock('../../src/middleware/authMiddleware', () => ({
    requireApiKey: (req, _res, next) => {
      req.user = { userId };
      next();
    }
  }));

  jest.doMock('../../src/middleware/rateLimitMiddleware', () => {
    const actual = jest.requireActual('../../src/middleware/rateLimitMiddleware');
    return {
      ...actual,
      agentApiRateLimiter: (_req, _res, next) => next(),
      agentPollingRateLimiter: (_req, _res, next) => next(),
      feedbackRateLimiter: (_req, _res, next) => next(),
      agentMessageIngressRateLimiter: actual.createRateLimiter({
        windowMs: 60_000,
        max: 2,
        message: 'too many spam messages from this agent',
        keyPrefix: 'test-agent-message-ingress',
        perAgent: true
      })
    };
  });

  const agentApiRoutes = require('../../src/routes/agentApiRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);

  return { app, query, pool };
}

describe('Agent message ingress rate limiting', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('limits inbound spam per agent without blocking other agents for the same user', async () => {
    const { app, query, pool } = await createContext();

    await request(app).post('/api/agent/messages').send({ agentName: 'SpamA', content: 'm1' }).expect(201);
    await request(app).post('/api/agent/messages').send({ agentName: 'SpamA', content: 'm2' }).expect(201);

    const limited = await request(app)
      .post('/api/agent/messages')
      .send({ agentName: 'SpamA', content: 'm3' })
      .expect(429);

    expect(limited.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(limited.body.error.message).toBe('too many spam messages from this agent');

    // Different agent should still be allowed.
    await request(app).post('/api/agent/messages').send({ agentName: 'SpamB', content: 'm1' }).expect(201);
    await request(app).post('/api/agent/messages').send({ agentName: 'SpamB', content: 'm2' }).expect(201);

    const counts = await query(
      `SELECT a.agent_name, COUNT(*)::int AS count
       FROM messages m
       INNER JOIN agents a ON a.agent_id = m.agent_id
       GROUP BY a.agent_name`
    );
    const byAgent = Object.fromEntries(counts.rows.map((row) => [row.agent_name, row.count]));
    expect(byAgent).toEqual({
      SpamA: 2,
      SpamB: 2
    });

    await pool.end();
  });

  it('shares the same per-agent cap across /messages and /questions', async () => {
    const { app, pool } = await createContext();

    await request(app).post('/api/agent/messages').send({ agentName: 'MixedSpam', content: 'm1' }).expect(201);
    await request(app).post('/api/agent/messages').send({ agentName: 'MixedSpam', content: 'm2' }).expect(201);

    const limitedQuestion = await request(app)
      .post('/api/agent/questions')
      .send({ agentName: 'MixedSpam', content: 'q1' })
      .expect(429);

    expect(limitedQuestion.body.error.code).toBe('RATE_LIMIT_EXCEEDED');

    await pool.end();
  });
});
