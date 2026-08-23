const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const { createTestDatabase, applyRuntimeUserColumns, seedUser, applyArchiveSchema } = require('../utils/pgMemTestUtils');

// ── User API test context (session-authenticated) ──────────────────────────
async function createUserApiTestContext() {
  jest.resetModules();

  const { pool, query } = createTestDatabase();
  await applyRuntimeUserColumns(query);
  await applyArchiveSchema(query);
  // Add stop_requested_at column
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMP DEFAULT NULL');
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

// ── Agent API test context (API-key authenticated) ─────────────────────────
async function createAgentApiTestContext() {
  jest.resetModules();

  const { pool, query } = createTestDatabase();
  await applyRuntimeUserColumns(query);
  await applyArchiveSchema(query);
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMP DEFAULT NULL');
  const { userId } = await seedUser(query);

  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => query(text, params),
    getClient: () => pool.connect(),
    pool,
  }));

  jest.doMock('../../src/utils/securityLogger', () => ({
    logApiKeyUsage: jest.fn(),
    logRateLimitViolation: jest.fn(),
  }));

  jest.doMock('../../src/middleware/authMiddleware', () => ({
    requireApiKey: (req, _res, next) => {
      req.user = { userId };
      next();
    },
  }));

  jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
    agentPollingRateLimiter: (_req, _res, next) => next(),
    agentApiRateLimiter: (_req, _res, next) => next(),
    agentMessageIngressRateLimiter: (_req, _res, next) => next(),
    feedbackRateLimiter: (_req, _res, next) => next(),
  }));

  const agentApiRoutes = require('../../src/routes/agentApiRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);

  return { app, query, pool, userId };
}

describe('Agent stop functionality', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  // ── POST /api/user/agents/:agentId/stop ──────────────────────────────────

  describe('POST /api/user/agents/:agentId/stop', () => {
    it('returns 400 for invalid agent ID format', async () => {
      const { app } = await createUserApiTestContext();
      const res = await request(app)
        .post('/api/user/agents/not-a-uuid/stop')
        .send()
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it('returns 403 for non-existent agent', async () => {
      const { app } = await createUserApiTestContext();
      const fakeId = uuidv4();
      const res = await request(app)
        .post(`/api/user/agents/${fakeId}/stop`)
        .send()
        .expect(403);
      expect(res.body.error).toBeDefined();
    });

    it('sets stop_requested_at in the database', async () => {
      const { app, query, userId } = await createUserApiTestContext();

      const agentId = uuidv4();
      await query(
        'INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)',
        [agentId, userId, 'StopTestAgent', 1]
      );

      const res = await request(app)
        .post(`/api/user/agents/${agentId}/stop`)
        .send()
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.agentId).toBe(agentId);
      expect(res.body.agentName).toBe('StopTestAgent');

      // Verify DB flag was set
      const dbResult = await query(
        'SELECT stop_requested_at FROM agents WHERE agent_id = $1',
        [agentId]
      );
      expect(dbResult.rows[0].stop_requested_at).not.toBeNull();
    });

    it('cannot stop another user\'s agent', async () => {
      const { app, query } = await createUserApiTestContext();

      const otherUserId = uuidv4();
      await seedUser(query, { userId: otherUserId, email: 'other@test.com', apiKey: 'other-api-key' });
      const agentId = uuidv4();
      await query(
        'INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)',
        [agentId, otherUserId, 'OtherAgent', 1]
      );

      await request(app)
        .post(`/api/user/agents/${agentId}/stop`)
        .send()
        .expect(403);
    });
  });

  // ── POST /api/agent/stop ─────────────────────────────────────────────────

  describe('POST /api/agent/stop', () => {
    it('returns validation error when agentName missing', async () => {
      const { app } = await createAgentApiTestContext();
      const res = await request(app)
        .post('/api/agent/stop')
        .send({})
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it('returns 404 for non-existent agent', async () => {
      const { app } = await createAgentApiTestContext();
      const res = await request(app)
        .post('/api/agent/stop')
        .send({ agentName: 'nonexistent-agent' })
        .expect(404);
      expect(res.body.error.code).toBe('AGENT_NOT_FOUND');
    });

    it('sets stop_requested_at in database for existing agent', async () => {
      const { app, query, userId } = await createAgentApiTestContext();

      const agentId = uuidv4();
      await query(
        'INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)',
        [agentId, userId, 'ApiStopAgent', 1]
      );

      const res = await request(app)
        .post('/api/agent/stop')
        .send({ agentName: 'ApiStopAgent' })
        .expect(200);

      expect(res.body.agentId).toBe(agentId);
      expect(res.body.agentName).toBe('ApiStopAgent');

      // Verify DB flag
      const dbResult = await query(
        'SELECT stop_requested_at FROM agents WHERE agent_id = $1',
        [agentId]
      );
      expect(dbResult.rows[0].stop_requested_at).not.toBeNull();
    });

    it('uses SIGKILL failsafe when local process survives SIGTERM', async () => {
      const { app, query, userId } = await createAgentApiTestContext();

      const agentId = uuidv4();
      const agentName = `forcekillagent${uuidv4().replace(/-/g, '').slice(0, 8)}`;
      const agentDir = path.join(process.cwd(), '.chatspace', agentName);
      const stateDir = path.join(agentDir, 'agent_state');
      fs.mkdirSync(stateDir, { recursive: true });

      const stubbornPid = 424242;
      fs.writeFileSync(path.join(stateDir, '.agent_pid'), String(stubbornPid));

      await query(
        'INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)',
        [agentId, userId, agentName, 1]
      );

      const killSpy = jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 'SIGTERM' && pid === -stubbornPid) return true;
        if (signal === 0 && pid === stubbornPid) return true;
        if (signal === 'SIGKILL' && pid === -stubbornPid) return true;
        throw Object.assign(new Error('process not found'), { code: 'ESRCH' });
      });

      try {
        const res = await request(app)
          .post('/api/agent/stop')
          .send({ agentName })
          .expect(200);

        expect(res.body.processKilled).toBe(true);
        expect(res.body.forceKilled).toBe(true);
        expect(killSpy).toHaveBeenCalledWith(-stubbornPid, 'SIGTERM');
        expect(killSpy).toHaveBeenCalledWith(stubbornPid, 0);
        expect(killSpy).toHaveBeenCalledWith(-stubbornPid, 'SIGKILL');
      } finally {
        killSpy.mockRestore();
        fs.rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('clears stop_requested_at when the agent acknowledges the stop', async () => {
      const { app, query, userId } = await createAgentApiTestContext();

      const agentId = uuidv4();
      const agentName = 'AckStopAgent';
      const stopTime = new Date();
      await query(
        'INSERT INTO agents (agent_id, user_id, agent_name, position, stop_requested_at) VALUES ($1, $2, $3, $4, $5)',
        [agentId, userId, agentName, 1, stopTime]
      );

      const res = await request(app)
        .post('/api/agent/stop/acknowledge')
        .send({ agentName })
        .expect(200);

      expect(res.body.acknowledged).toBe(true);
      expect(res.body.agentId).toBe(agentId);
      expect(res.body.agentName).toBe(agentName);

      const dbResult = await query(
        'SELECT stop_requested_at FROM agents WHERE agent_id = $1',
        [agentId]
      );
      expect(dbResult.rows[0].stop_requested_at).toBeNull();
    });
  });

  // ── Heartbeat returns stopRequested from DB ──────────────────────────────

  describe('POST /api/agent/heartbeat (stop detection)', () => {
    it('returns stopRequested:false when no stop is set', async () => {
      const { app, query, userId } = await createAgentApiTestContext();

      const agentId = uuidv4();
      await query(
        'INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)',
        [agentId, userId, 'HeartbeatAgent', 1]
      );

      const res = await request(app)
        .post('/api/agent/heartbeat')
        .send({ agentName: 'HeartbeatAgent', isWorking: true })
        .expect(200);

      expect(res.body.stopRequested).toBe(false);
      expect(res.body.stopRequestedAt).toBeNull();
    });

    it('returns stopRequested:true when stop_requested_at is set in DB', async () => {
      const { app, query, userId } = await createAgentApiTestContext();

      const agentId = uuidv4();
      const stopTime = new Date();
      await query(
        'INSERT INTO agents (agent_id, user_id, agent_name, position, stop_requested_at) VALUES ($1, $2, $3, $4, $5)',
        [agentId, userId, 'StoppedAgent', 1, stopTime]
      );

      const res = await request(app)
        .post('/api/agent/heartbeat')
        .send({ agentName: 'StoppedAgent', isWorking: true })
        .expect(200);

      expect(res.body.stopRequested).toBe(true);
      expect(res.body.stopRequestedAt).not.toBeNull();
    });
  });
});
