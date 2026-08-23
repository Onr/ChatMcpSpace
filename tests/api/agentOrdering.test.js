const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { AGENT_CLI_VERSION } = require('../../src/utils/agentCliVersion');

const { createTestDatabase, applyRuntimeUserColumns, seedUser, applyArchiveSchema } = require('../utils/pgMemTestUtils');

async function createTestContext() {
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
  }));

  jest.doMock('../../src/utils/logger', () => ({
    logInfo: jest.fn(),
    logWarn: jest.fn(),
    logError: jest.fn(),
  }));

        jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
          userPollingRateLimiter: (_req, _res, next) => next(),
          feedbackRateLimiter: (_req, _res, next) => next(),
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

  it('includes CLI update status fields based on reported version', async () => {
    const { app, query, pool, userId } = await createTestContext();
    const outdatedId = uuidv4();
    const currentId = uuidv4();

    await query(
      `INSERT INTO agents (agent_id, user_id, agent_name, position, reported_cli_version, reported_cli_version_at)
       VALUES ($1, $2, $3, $4, $5, NOW()::timestamp)`,
      [outdatedId, userId, 'Outdated Agent', 1, '0.9.0']
    );
    await query(
      `INSERT INTO agents (agent_id, user_id, agent_name, position, reported_cli_version, reported_cli_version_at)
       VALUES ($1, $2, $3, $4, $5, NOW()::timestamp)`,
      [currentId, userId, 'Current Agent', 2, AGENT_CLI_VERSION]
    );

    const res = await request(app).get('/api/user/agents').expect(200);
    const outdated = res.body.agents.find((agent) => agent.agentId === outdatedId);
    const current = res.body.agents.find((agent) => agent.agentId === currentId);

    expect(outdated).toMatchObject({
      reportedCliVersion: '0.9.0',
      latestCliVersion: AGENT_CLI_VERSION,
      needsCliUpdate: true
    });
    expect(outdated.reportedCliVersionAt).toBeTruthy();

    expect(current).toMatchObject({
      reportedCliVersion: AGENT_CLI_VERSION,
      latestCliVersion: AGENT_CLI_VERSION,
      needsCliUpdate: false
    });

    await pool.end();
  });

  it('includes explicit lastSeenAt for dashboard poll visibility', async () => {
    const { app, query, pool, userId } = await createTestContext();
    const agentId = uuidv4();
    const lastSeenAt = new Date('2026-02-03T04:05:06.000Z');

    await query(
      `INSERT INTO agents (agent_id, user_id, agent_name, position, last_seen_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [agentId, userId, 'Polling Agent', 1, lastSeenAt]
    );

    const res = await request(app).get('/api/user/agents').expect(200);
    const agent = res.body.agents.find((row) => row.agentId === agentId);

    expect(agent.lastSeenAt).toBe(lastSeenAt.toISOString());
    expect(agent.lastActivityTime).toBe(lastSeenAt.toISOString());

    await pool.end();
  });
});
