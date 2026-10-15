const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const { Bridge, seal, open, REPLY_TYPE } = require('../../scripts/external-agent-bridge');

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
    getClient: async () => {
      const client = await pool.connect();
      return {
        release: () => client.release(),
        query: (sql, params) => {
          // pg-mem lacks SELECT EXISTS; these columns exist in the real fixture schema.
          if (sql.includes('information_schema.columns') && sql.includes('AS has_client_id')) return Promise.resolve({ rows: [{ has_client_id: true }] });
          if (sql.includes('information_schema.columns') && sql.includes('AS has_run_command')) return Promise.resolve({ rows: [{ has_run_command: true }] });
          // pg-mem cannot parse the partial-index predicate on ON CONFLICT.
          // Fixture inputs use non-null UUIDs; preserve the conflict target and update.
          return client.query(sql.replace('ON CONFLICT (agent_id, client_message_id) WHERE client_message_id IS NOT NULL', 'ON CONFLICT (agent_id, client_message_id)'), params);
        }
      };
    },
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

  // Keep attachment integration tests entirely in memory.
  const blobs = new Map();
  const storage = {
    store: jest.fn(async (bytes, id) => { blobs.set(id, Buffer.from(bytes)); return id; }),
    retrieve: jest.fn(async id => blobs.get(id)),
    delete: jest.fn(async id => blobs.delete(id))
  };
  jest.doMock('../../src/storage', () => ({ initializeStorage: async () => storage }));

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

  it('keeps rich history and attachment transfer scoped to the paired identity', async () => {
    const { app, query, pool, userId } = await createContext();
    try {
      const approval = await request(app).post('/api/user/external-agents/pairing-codes')
        .send({ provider: 'hermes', agentName: 'Files' }).expect(201);
      const paired = await request(app).post('/api/agent/pairing/redeem')
        .send({ pairingCode: approval.body.pairingCode }).expect(201);
      const token = paired.body.credential.agentToken;
      const agentId = paired.body.agent.agentId;
      const other = await query("INSERT INTO agents (user_id, agent_name, position) VALUES ($1, 'Private', 2) RETURNING agent_id", [userId]);
      const upload = name => request(app).post('/api/agent/attachments').set('X-Agent-Token', token)
        .field('agentName', name).field('ivBase64', Buffer.alloc(12).toString('base64'))
        .field('authTagBase64', Buffer.alloc(16).toString('base64')).field('contentType', 'text/plain')
        .attach('file', Buffer.from('ciphertext'), { filename: 'notes.txt', contentType: 'text/plain' });
      await upload('Private').expect(403);
      const uploaded = await upload('Files').expect(201);
      const attachmentId = uploaded.body.attachmentId;
      await request(app).get(`/api/agent/attachments/${attachmentId}`).set('X-Agent-Token', token).expect(200);
      const message = await query("INSERT INTO user_messages (agent_id, content, encrypted) VALUES ($1, 'caption', FALSE) RETURNING user_message_id", [agentId]);
      await query('INSERT INTO user_message_attachments (user_message_id, attachment_id) VALUES ($1, $2)', [message.rows[0].user_message_id, attachmentId]);
      const inbox = await request(app).get('/api/agent/responses?markRead=false').set('X-Agent-Token', token).expect(200);
      expect(inbox.body.responses[0].attachments[0]).toMatchObject({ attachmentId, downloadUrl: `/api/agent/attachments/${attachmentId}` });
      const history = await request(app).get('/api/agent/messages/history?agentName=Files').set('X-Agent-Token', token).expect(200);
      expect(history.body.messages[0]).toMatchObject({ content: 'caption', encrypted: false,
        attachments: [{ attachmentId, contentType: 'text/plain', encryption: { alg: 'AES-GCM' } }] });
      await request(app).get('/api/agent/messages/history?agentName=Private').set('X-Agent-Token', token).expect(403);
      const privateId = crypto.randomUUID();
      await query("INSERT INTO attachments (attachment_id, content_type, size_bytes, storage_key, agent_id, uploaded_by) VALUES ($1, 'image/png', 3, 'private', $2, 'user')", [privateId, other.rows[0].agent_id]);
      await request(app).get(`/api/agent/attachments/${privateId}`).set('X-Agent-Token', token).expect(404);
      // File delivery can be retried after a lost response without a duplicate.
      const body = { agentName: 'Files', content: 'result', encrypted: false, attachmentIds: [attachmentId], clientMessageId: crypto.randomUUID() };
      const sent = await request(app).post('/api/agent/messages').set('X-Agent-Token', token).send(body).expect(201);
      const duplicate = await request(app).post('/api/agent/messages').set('X-Agent-Token', token).send(body).expect(200);
      expect(duplicate.body).toMatchObject({ messageId: sent.body.messageId, attachmentCount: 1, idempotent: true });
      await request(app).post('/api/agent/messages').set('X-Agent-Token', token).send({ ...body, attachmentIds: [] }).expect(409);
    } finally { await pool.end(); }
  });

  it('carries a user request and central-agent assignment through an external runtime and back', async () => {
    const { app, query, pool, userId, apiKey } = await createContext();
    try {
      const approval = await request(app).post('/api/user/external-agents/pairing-codes')
        .send({ provider: 'hermes', agentName: 'Hermes', interAgentMode: 'listen_all' }).expect(201);
      const paired = await request(app).post('/api/agent/pairing/redeem')
        .send({ pairingCode: approval.body.pairingCode }).expect(201);
      const token = paired.body.credential.agentToken;
      const agentId = paired.body.agent.agentId;
      const key = crypto.randomBytes(32).toString('base64');
      const central = await query("INSERT INTO agents (user_id, agent_name, inter_agent_mode, position) VALUES ($1, 'Central', 'listen_all', 2) RETURNING agent_id", [userId]);
      const userMessage = await query('INSERT INTO user_messages (agent_id, content, encrypted) VALUES ($1, $2, TRUE) RETURNING user_message_id',
        [agentId, seal('Please summarize this project.', key)]);
      const otherMessage = await query('INSERT INTO user_messages (agent_id, content, encrypted) VALUES ($1, $2, TRUE) RETURNING user_message_id',
        [central.rows[0].agent_id, seal('Private central instruction', key)]);

      // No query filter must still mean only the token's bound inbox.
      const peek = await request(app).get('/api/agent/responses?markRead=false').set('X-Agent-Token', token).expect(200);
      expect(peek.body.responses.map(row => row.messageId)).toEqual([userMessage.rows[0].user_message_id]);
      await request(app).get('/api/agent/responses?agentName=Central').set('X-Agent-Token', token).expect(403);
      await request(app).post('/api/agent/messages').set('X-Agent-Token', token)
        .send({ agentName: 'Central', content: seal('Impersonation', key), encrypted: true }).expect(403);
      await request(app).post('/api/agent/responses/ack').set('X-Agent-Token', token)
        .send({ messageId: otherMessage.rows[0].user_message_id }).expect(404);
      expect((await query('SELECT read_at FROM user_messages WHERE user_message_id = $1', [userMessage.rows[0].user_message_id])).rows[0].read_at).toBeNull();

      const calls = [];
      const fetchImpl = async (url, options = {}) => {
        if (url.startsWith('http://127.0.0.1:8642/')) {
          expect(options.headers.Authorization).toBe('Bearer local-runtime-key');
          expect(options.headers['X-Agent-Token']).toBeUndefined();
          const input = JSON.parse(options.body);
          calls.push(input);
          return { ok: true, json: async () => ({ choices: [{ message: { content: `Result ${calls.length}` } }] }) };
        }
        const address = new URL(url);
        let req = request(app)[(options.method || 'GET').toLowerCase()](address.pathname + address.search).set(options.headers || {});
        if (options.body) req = req.send(JSON.parse(options.body));
        const res = await req;
        return { ok: res.status < 400, status: res.status, headers: { get: key => res.headers[key.toLowerCase()] }, json: async () => res.body };
      };
      const state = { version: 1, baseUrl: 'https://chatspace.test', agentName: 'Hermes', agentId, token, key, history: {}, pending: null };
      const bridge = new Bridge(state, { fetchImpl, runtimeKey: 'local-runtime-key' });
      await bridge.tick();
      expect(calls[0].messages.at(-1).content).toBe('Please summarize this project.');
      const reply = await query('SELECT content, encrypted FROM messages WHERE agent_id = $1', [agentId]);
      expect(reply.rows).toHaveLength(1);
      expect(reply.rows[0].encrypted).toBe(true);
      expect(open(reply.rows[0].content, key)).toBe('Result 1');
      expect((await query('SELECT read_at FROM user_messages WHERE user_message_id = $1', [userMessage.rows[0].user_message_id])).rows[0].read_at).toBeTruthy();

      const assignment = await request(app).post('/api/agent/messages/direct')
        .set('X-API-Key', apiKey).set('X-Agent-Name', 'Central')
        .send({ toAgentName: 'Hermes', content: seal('Investigate the next milestone.', key), encrypted: true }).expect(201);
      await bridge.tick();
      expect(JSON.parse(calls[1].messages.at(-1).content)).toMatchObject({ source: 'peer_agent', fromAgent: 'Central' });
      // Separate histories: a peer does not inherit the user's private thread.
      expect(JSON.stringify(calls[1])).not.toContain('Please summarize this project.');
      const result = await request(app).get('/api/agent/messages/direct?markRead=false')
        .set('X-API-Key', apiKey).set('X-Agent-Name', 'Central').expect(200);
      expect(JSON.parse(open(result.body.messages[0].content, key))).toEqual({ type: REPLY_TYPE, inReplyTo: assignment.body.messageId, content: 'Result 2' });
      const mirror = await query('SELECT content FROM messages WHERE agent_id = $1', [agentId]);
      expect(mirror.rows.map(row => open(row.content, key))).toContain('Reply to Central:\n\nResult 2');
      await bridge.tick();
      expect(calls).toHaveLength(2);
    } finally { await pool.end(); }
  });

  it('deduplicates encrypted peer replies and rejects conflicting reuse of an ID', async () => {
    const { app, query, pool, userId, apiKey } = await createContext();
    try {
      await query("INSERT INTO agents (user_id, agent_name, inter_agent_mode, position) VALUES ($1, 'Sender', 'listen_all', 1), ($1, 'Receiver', 'listen_all', 2)", [userId]);
      const body = { toAgentName: 'Receiver', content: 'encrypted:tag:body', encrypted: true, clientMessageId: crypto.randomUUID() };
      const send = payload => request(app).post('/api/agent/messages/direct').set('X-API-Key', apiKey).set('X-Agent-Name', 'Sender').send(payload);
      await send(body).expect(201);
      const retry = await send(body).expect(200);
      expect(retry.body.idempotent).toBe(true);
      await send({ ...body, content: 'different:encrypted:body' }).expect(409);
      expect((await query('SELECT agent_message_id FROM agent_messages')).rows).toHaveLength(1);
    } finally { await pool.end(); }
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
    expect(res.body.externalAgentBridge.protocolVersion).toBe(1);
    expect(res.body.externalAgentBridge.userInbox).toContain('markRead=false');

    const script = await request(app).get('/api/agent/external-bridge.js').expect(200);
    expect(script.headers['content-disposition']).toContain('external-agent-bridge.js');
    const guide = await request(app).get('/api/agent/external-bridge-guide').expect(200);
    expect(guide.text).toContain('Bring an existing agent');
    expect(res.body.externalAgentBridge.agentInstructions).toContain('/api/agent/connection-instructions');
    const instructions = await request(app).get('/api/agent/connection-instructions').expect(200);
    expect(instructions.headers['content-type']).toContain('text/plain');
    expect(instructions.text).toContain('Keep exactly one `run` process per state file');
    const help = await request(app).get('/api/agent/connection-help').expect(200);
    expect(help.text).toContain('Settings → Bring your own agent');

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

  it('acknowledges question replies explicitly and keeps peer acknowledgements scoped', async () => {
    const { app, query, pool, userId, apiKey } = await createContext();
    try {
      const created = await request(app).post('/api/user/external-bots/openclaw')
        .send({ agentName: 'External', interAgentMode: 'disabled' }).expect(201);
      const token = created.body.credential.oneTimeAgentToken;
      const agentId = (await query("SELECT agent_id FROM agents WHERE agent_name = 'External' AND user_id = $1", [userId])).rows[0].agent_id;
      const other = (await query("INSERT INTO agents (user_id, agent_name, inter_agent_mode, position) VALUES ($1, 'Peer', 'listen_all', 2) RETURNING agent_id", [userId])).rows[0].agent_id;
      const question = (await query("INSERT INTO messages (agent_id, message_type, content) VALUES ($1, 'question', 'Question') RETURNING message_id", [agentId])).rows[0].message_id;
      const optionId = (await query("INSERT INTO question_options (message_id, option_text, option_order) VALUES ($1, 'Choice', 0) RETURNING option_id", [question])).rows[0].option_id;
      const answerId = (await query("INSERT INTO user_responses (message_id, option_id, free_response, read_at) VALUES ($1, $2, 'Answer', NULL) RETURNING response_id", [question, optionId])).rows[0].response_id;
      const peek = () => request(app).get('/api/agent/responses?markRead=false').set('X-Agent-Token', token);
      expect((await peek().expect(200)).body.responses[0].responseId).toBe(answerId);
      expect((await peek().expect(200)).body.responses).toHaveLength(1);
      await request(app).post('/api/agent/responses/ack').set('X-Agent-Token', token)
        .send({ messageId: answerId, responseType: 'response' }).expect(200);
      expect((await peek().expect(200)).body.responses).toHaveLength(0);
      const dmId = (await query("INSERT INTO agent_messages (sender_agent_id, recipient_agent_id, content, encrypted) VALUES ($1, $2, 'cipher', TRUE) RETURNING agent_message_id", [agentId, other])).rows[0].agent_message_id;
      await request(app).post('/api/agent/messages/direct/ack').set('X-Agent-Token', token).send({ messageId: dmId }).expect(404);
      await request(app).post('/api/agent/messages/direct').set('X-Agent-Token', token)
        .send({ toAgentName: 'Peer', content: 'cipher', encrypted: true }).expect(403);
      // Existing API-key users retain legacy read-on-delivery behavior.
      const legacy = await request(app).get('/api/agent/messages/direct').set('X-API-Key', apiKey).set('X-Agent-Name', 'Peer').expect(200);
      expect(legacy.body.messages[0].messageId).toBe(dmId);
      expect((await query('SELECT read_at FROM agent_messages WHERE agent_message_id = $1', [dmId])).rows[0].read_at).toBeTruthy();
    } finally { await pool.end(); }
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
