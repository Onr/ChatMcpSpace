const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const { createTestDatabase, applyRuntimeUserColumns, seedUser } = require('../utils/pgMemTestUtils');

async function createTestContext() {
  jest.resetModules();

  const { pool, query } = createTestDatabase();
  await applyRuntimeUserColumns(query);
  const { userId } = await seedUser(query);

  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => query(text, params),
    getClient: () => pool.connect(),
    pool,
  }));

  jest.doMock('../../src/utils/securityLogger', () => ({
    logUnauthorizedAccess: jest.fn(),
    logApiKeyUsage: jest.fn(),
  }));

  jest.doMock('../../src/utils/logger', () => ({
    logInfo: jest.fn(),
    logWarn: jest.fn(),
    logError: jest.fn(),
  }));

  jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
    userPollingRateLimiter: (_req, _res, next) => next(),
  }));

  jest.doMock('../../src/services/ttsService', () => ({
    getAudioUrl: jest.fn().mockResolvedValue(null),
  }));

  const userApiRoutes = require('../../src/routes/userApiRoutes');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId };
    next();
  });
  app.use('/api/user', userApiRoutes);

  return { app, query, pool, userId };
}

describe('Agent ordering', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('returns agents ordered by position (stable UI ordering)', async () => {
    const { app, query, pool, userId } = await createTestContext();

    const alphaId = uuidv4();
    const betaId = uuidv4();
    const gammaId = uuidv4();

    await query(
      'INSERT INTO agents (agent_id, user_id, agent_name, position, created_at) VALUES ($1, $2, $3, $4, $5)',
      [alphaId, userId, 'Alpha', 2, new Date('2026-01-02T00:00:00.000Z')]
    );
    await query(
      'INSERT INTO agents (agent_id, user_id, agent_name, position, created_at) VALUES ($1, $2, $3, $4, $5)',
      [betaId, userId, 'Beta', 1, new Date('2026-01-03T00:00:00.000Z')]
    );
    await query(
      'INSERT INTO agents (agent_id, user_id, agent_name, position, created_at) VALUES ($1, $2, $3, $4, $5)',
      [gammaId, userId, 'Gamma', 3, new Date('2026-01-01T00:00:00.000Z')]
    );

    const res = await request(app).get('/api/user/agents').expect(200);
    const names = res.body.agents.map((a) => a.name);
    expect(names).toEqual(['Beta', 'Alpha', 'Gamma']);

    await pool.end();
  });
});

