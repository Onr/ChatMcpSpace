const express = require('express');
const request = require('supertest');

const {
  createTestDatabase,
  applyRuntimeUserColumns,
  applyArchiveSchema,
  seedUser
} = require('../utils/pgMemTestUtils');

async function createContext() {
  jest.resetModules();

  const { pool, query } = createTestDatabase();
  await applyRuntimeUserColumns(query);
  await applyArchiveSchema(query);
  const { userId, apiKey } = await seedUser(query);

  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => query(text, params),
    getClient: () => pool.connect(),
    pool
  }));

  jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
    userPollingRateLimiter: (_req, _res, next) => next(),
    agentPollingRateLimiter: (_req, _res, next) => next(),
    agentApiRateLimiter: (_req, _res, next) => next(),
    agentMessageIngressRateLimiter: (_req, _res, next) => next(),
    feedbackRateLimiter: (_req, _res, next) => next()
  }));

  jest.doMock('../../src/services/ttsService', () => ({
    getAudioUrl: jest.fn().mockResolvedValue(null)
  }));

  jest.doMock('../../src/utils/securityLogger', () => ({
    logUnauthorizedAccess: jest.fn(),
    logApiKeyUsage: jest.fn(),
    logRateLimitViolation: jest.fn()
  }));

  const userApiRoutes = require('../../src/routes/userApiRoutes');
  const agentApiRoutes = require('../../src/routes/agentApiRoutes');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId };
    next();
  });
  app.use('/api/user', userApiRoutes);
  app.use('/api/agent', agentApiRoutes);

  return { app, query, pool, userId, apiKey };
}

describe('External OpenClaw bot onboarding', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('creates external connection and returns scoped token', async () => {
    const { app, query, pool, userId } = await createContext();

    const res = await request(app)
      .post('/api/user/external-bots/openclaw')
      .send({
        agentName: 'OpenClawWorker',
        providerBotRef: 'claw-bot-1',
        interAgentMode: 'groups',
        groupNames: ['ops'],
        canSpawn: false
      })
      .expect(201);

    expect(res.body.connectionId).toBeTruthy();
    expect(res.body.credential.oneTimeAgentToken).toMatch(/^agt_/);
    expect(res.body.agent.name).toBe('OpenClawWorker');

    const conn = await query('SELECT * FROM external_bot_connections WHERE user_id = $1', [userId]);
    expect(conn.rows).toHaveLength(1);
    expect(conn.rows[0].provider).toBe('openclaw');

    const creds = await query('SELECT * FROM agent_api_credentials WHERE agent_id = $1', [conn.rows[0].agent_id]);
    expect(creds.rows).toHaveLength(1);
    expect(creds.rows[0].token_hash).toBeTruthy();

    await pool.end();
  });

  it('advertises agent-started pairing in the public connect guide', async () => {
    const { app, pool } = await createContext();

    const res = await request(app)
      .get('/api/agent/connect-guide')
      .expect(200);

    expect(res.body.preferredOnboarding.mode).toBe('agent_started_pairing');
    expect(res.body.preferredOnboarding.userPromptExample).toContain('Connect to ChatMCP');
    expect(res.body.preferredOnboarding.userPromptExample).toContain('guide me through what needs to be done');
    expect(res.body.preferredOnboarding.agentSetupGoal).toContain('read this guide');
    expect(res.body.preferredOnboarding.approvalUrlTemplate).toContain('/settings/external-agents/approve');
    expect(res.body.preferredOnboarding.userMustNotBeAskedFor.join(' ')).toContain('Full ChatMCPSpace account API key');
    expect(res.body.preferredOnboarding.redeem.path).toBe('/api/agent/pairing/redeem');

    await pool.end();
  });

  it('creates a short-lived pairing code and redeems it for a scoped token', async () => {
    const { app, query, pool, userId } = await createContext();

    const approveRes = await request(app)
      .post('/api/user/external-agents/pairing-codes')
      .send({
        provider: 'hermes',
        agentName: 'HermesBridge',
        providerBotRef: 'local-hermes',
        interAgentMode: 'groups',
        groupNames: ['ops'],
        canSpawn: false
      })
      .expect(201);

    expect(approveRes.body.pairingCode).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(approveRes.body.instructions.join(' ')).toContain('Do not give the external agent your full API key');

    const redeemRes = await request(app)
      .post('/api/agent/pairing/redeem')
      .send({
        pairingCode: approveRes.body.pairingCode.toLowerCase(),
        providerBotRef: 'redeemed-hermes'
      })
      .expect(201);

    expect(redeemRes.body.provider).toBe('hermes');
    expect(redeemRes.body.agent.name).toBe('HermesBridge');
    expect(redeemRes.body.credential.agentToken).toMatch(/^agt_/);
    expect(redeemRes.body.encryptionSalt).toBe('salt');

    const conn = await query('SELECT * FROM external_bot_connections WHERE user_id = $1', [userId]);
    expect(conn.rows).toHaveLength(1);
    expect(conn.rows[0].status).toBe('connected');
    expect(conn.rows[0].provider).toBe('hermes');
    expect(conn.rows[0].provider_bot_ref).toBe('redeemed-hermes');

    const pairing = await query('SELECT redeemed_at FROM external_agent_pairing_codes WHERE user_id = $1', [userId]);
    expect(pairing.rows[0].redeemed_at).toBeTruthy();

    await request(app)
      .get('/api/agent/discover')
      .set('X-Agent-Token', redeemRes.body.credential.agentToken)
      .expect(200);

    await pool.end();
  });

  it('prevents pairing-code replay', async () => {
    const { app, pool } = await createContext();

    const approveRes = await request(app)
      .post('/api/user/external-agents/pairing-codes')
      .send({ provider: 'openclaw', agentName: 'ReplayGuard' })
      .expect(201);

    await request(app)
      .post('/api/agent/pairing/redeem')
      .send({ pairingCode: approveRes.body.pairingCode })
      .expect(201);

    await request(app)
      .post('/api/agent/pairing/redeem')
      .send({ pairingCode: approveRes.body.pairingCode })
      .expect(409);

    await pool.end();
  });

  it('scoped token can authenticate and logs auth event', async () => {
    const { app, query, pool } = await createContext();

    const createRes = await request(app)
      .post('/api/user/external-bots/openclaw')
      .send({ agentName: 'ClawAuthBot', interAgentMode: 'listen_all' })
      .expect(201);

    const token = createRes.body.credential.oneTimeAgentToken;

    await request(app)
      .get('/api/agent/discover')
      .set('X-Agent-Token', token)
      .expect(200);

    const events = await query("SELECT * FROM agent_auth_events WHERE event_type = 'auth_success'");
    expect(events.rows.length).toBeGreaterThan(0);

    await pool.end();
  });

  it('token rotation revokes old token', async () => {
    const { app, pool } = await createContext();

    const createRes = await request(app)
      .post('/api/user/external-bots/openclaw')
      .send({ agentName: 'RotateBot' })
      .expect(201);

    const connectionId = createRes.body.connectionId;
    const oldToken = createRes.body.credential.oneTimeAgentToken;

    const rotateRes = await request(app)
      .post(`/api/user/external-bots/${connectionId}/rotate-credential`)
      .send({})
      .expect(200);

    const newToken = rotateRes.body.credential.oneTimeAgentToken;
    expect(newToken).toMatch(/^agt_/);
    expect(newToken).not.toBe(oldToken);

    await request(app)
      .get('/api/agent/discover')
      .set('X-Agent-Token', oldToken)
      .expect(401);

    await request(app)
      .get('/api/agent/discover')
      .set('X-Agent-Token', newToken)
      .expect(200);

    await pool.end();
  });
});
