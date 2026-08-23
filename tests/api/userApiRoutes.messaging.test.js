const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const { createTestDatabase, applyRuntimeUserColumns, seedUser, applyArchiveSchema } = require('../utils/pgMemTestUtils');

async function createUserApiTestContext() {
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

describe('User API routes (messaging)', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('POST /api/user/messages creates a user message (supports encryption flag)', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Alpha',
      1,
    ]);

    const res = await request(app)
      .post('/api/user/messages')
      .send({ agentId, content: ' hi ', encrypted: true })
      .expect(201);

    const row = await query('SELECT content, encrypted FROM user_messages WHERE user_message_id = $1', [res.body.messageId]);
    expect(row.rows[0]).toMatchObject({ content: 'hi', encrypted: true });

    await pool.end();
  });

  it('POST /api/user/feedback accepts the text submission used by the feedback button', async () => {
    const { app, query, pool } = await createUserApiTestContext();

    const response = await request(app)
      .post('/api/user/feedback')
      .send({ kind: 'feedback', message: 'The feedback button works.', pageUrl: 'https://example.test/dashboard' })
      .expect(201);

    expect(response.body).toMatchObject({ success: true });
    const result = await query(
      'SELECT kind, message, page_url FROM feedback WHERE feedback_id = $1',
      [response.body.feedbackId]
    );
    expect(result.rows).toEqual([{
      kind: 'feedback',
      message: 'The feedback button works.',
      page_url: 'https://example.test/dashboard'
    }]);
    await pool.end();
  });

  it('POST /api/user/feedback accepts the multipart submission used with an image attachment', async () => {
    const { app, query, pool } = await createUserApiTestContext();

    const response = await request(app)
      .post('/api/user/feedback')
      .field('kind', 'feedback')
      .field('message', 'Screenshot attached')
      .field('pageUrl', 'https://example.test/dashboard')
      .attach('image', Buffer.from('png-content'), { filename: 'issue.png', contentType: 'image/png' })
      .expect(201);

    const result = await query(
      'SELECT kind, message, image_content_type, image_filename, image_data FROM feedback WHERE feedback_id = $1',
      [response.body.feedbackId]
    );
    expect(result.rows[0]).toMatchObject({
      kind: 'feedback',
      message: 'Screenshot attached',
      image_content_type: 'image/png',
      image_filename: 'issue.png'
    });
    expect(Buffer.from(result.rows[0].image_data)).toEqual(Buffer.from('png-content'));
    await pool.end();
  });

  it('POST /api/user/messages/schedule stores an owned agent message for future delivery', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();
    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId, userId, 'Alpha', 1,
    ]);

    const scheduledFor = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const res = await request(app)
      .post('/api/user/messages/schedule')
      .send({ agentId, content: 'send this later', encrypted: true, scheduledFor })
      .expect(201);

    const rows = await query(
      'SELECT content, encrypted, delivered_at FROM scheduled_user_messages WHERE scheduled_message_id = $1',
      [res.body.scheduledMessageId]
    );
    expect(rows.rows[0]).toMatchObject({ content: 'send this later', encrypted: true, delivered_at: null });
    const immediate = await query('SELECT count(*)::int AS count FROM user_messages WHERE agent_id = $1', [agentId]);
    expect(immediate.rows[0].count).toBe(0);
    await pool.end();
  });

  it('POST /api/user/messages/schedule rejects past times', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();
    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId, userId, 'Alpha', 1,
    ]);
    await request(app).post('/api/user/messages/schedule').send({
      agentId, content: 'too late', scheduledFor: new Date(Date.now() - 1000).toISOString(),
    }).expect(400);
    await pool.end();
  });

  it('lists, edits, and cancels a pending scheduled message', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();
    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [agentId, userId, 'Alpha', 1]);
    const created = await request(app).post('/api/user/messages/schedule').send({ agentId, content: 'later', scheduledFor: new Date(Date.now() + 10 * 60 * 1000).toISOString() }).expect(201);
    const listed = await request(app).get(`/api/user/messages/scheduled?agentId=${agentId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.scheduledMessages).toHaveLength(1);
    await request(app).patch(`/api/user/messages/scheduled/${created.body.scheduledMessageId}`).send({ content: 'updated', scheduledFor: new Date(Date.now() + 20 * 60 * 1000).toISOString() }).expect(200);
    await request(app).delete(`/api/user/messages/scheduled/${created.body.scheduledMessageId}`).expect(204);
    await pool.end();
  });

  it('POST /api/user/messages forbids sending to agents not owned by the user', async () => {
    const { app, query, pool } = await createUserApiTestContext();

    const otherUserId = uuidv4();
    await query(
      'INSERT INTO users (user_id, email, password_hash, api_key, script_token, encryption_salt, email_verified) VALUES ($1, $2, $3, $4, $5, $6, TRUE)',
      [otherUserId, 'other@example.com', 'hash', 'api-key-2', 'script-token-2', 'salt']
    );

    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      otherUserId,
      'Other',
      1,
    ]);

    const res = await request(app).post('/api/user/messages').send({ agentId, content: 'x' }).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN_RESOURCE');

    await pool.end();
  });

  it('POST /api/user/responses stores response and creates a corresponding user_message', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    const questionId = uuidv4();
    const optionId = uuidv4();

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Alpha',
      1,
    ]);
    await query(
      `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response)
       VALUES ($1, $2, 'question', $3, 0, FALSE, TRUE)`,
      [questionId, agentId, 'q']
    );
    await query(
      `INSERT INTO question_options (option_id, message_id, option_text, benefits, downsides, is_default, option_order)
       VALUES ($1, $2, $3, NULL, NULL, TRUE, 0)`,
      [optionId, questionId, 'Yes']
    );

    const res = await request(app)
      .post('/api/user/responses')
      .send({ questionId, optionId, freeResponse: 'ok' })
      .expect(201);

    const responseRow = await query('SELECT option_id, free_response FROM user_responses WHERE response_id = $1', [
      res.body.responseId,
    ]);
    expect(responseRow.rows[0]).toMatchObject({ option_id: optionId, free_response: 'ok' });

    const userMessageRow = await query('SELECT content FROM user_messages WHERE user_message_id = $1', [res.body.messageId]);
    expect(userMessageRow.rows[0].content).toContain('Selected: "Yes"');
    expect(userMessageRow.rows[0].content).toContain('ok');

    await pool.end();
  });

  it('POST /api/user/responses rejects duplicate responses', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    const questionId = uuidv4();
    const optionId = uuidv4();

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Alpha',
      1,
    ]);
    await query(
      `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response)
       VALUES ($1, $2, 'question', $3, 0, FALSE, TRUE)`,
      [questionId, agentId, 'q']
    );
    await query(
      `INSERT INTO question_options (option_id, message_id, option_text, benefits, downsides, is_default, option_order)
       VALUES ($1, $2, $3, NULL, NULL, TRUE, 0)`,
      [optionId, questionId, 'Yes']
    );

    await request(app).post('/api/user/responses').send({ questionId, optionId }).expect(201);
    const dup = await request(app).post('/api/user/responses').send({ questionId, optionId }).expect(409);
    expect(dup.body.error.code).toBe('DUPLICATE_RESPONSE');

    await pool.end();
  });

  it('POST /api/user/responses handles concurrent duplicate submissions', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    const questionId = uuidv4();
    const optionId = uuidv4();

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Alpha',
      1,
    ]);
    await query(
      `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response)
       VALUES ($1, $2, 'question', $3, 0, FALSE, TRUE)`,
      [questionId, agentId, 'q']
    );
    await query(
      `INSERT INTO question_options (option_id, message_id, option_text, benefits, downsides, is_default, option_order)
       VALUES ($1, $2, $3, NULL, NULL, TRUE, 0)`,
      [optionId, questionId, 'Yes']
    );

    const [first, second] = await Promise.all([
      request(app).post('/api/user/responses').send({ questionId, optionId, freeResponse: 'ok' }),
      request(app).post('/api/user/responses').send({ questionId, optionId, freeResponse: 'ok' }),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const storedResponses = await query('SELECT count(*)::int as count FROM user_responses WHERE message_id = $1', [
      questionId,
    ]);
    expect(storedResponses.rows[0].count).toBe(1);

    await pool.end();
  });

  it('GET /api/user/messages/:agentId supports since filtering', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    const firstId = uuidv4();
    const secondId = uuidv4();

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Alpha',
      1,
    ]);

    await query(
      `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response, created_at)
       VALUES ($1, $2, 'message', $3, 0, FALSE, FALSE, $4)`,
      [firstId, agentId, 'first', new Date('2026-01-01T00:00:00.000Z')]
    );
    await query(
      `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response, created_at)
       VALUES ($1, $2, 'message', $3, 0, FALSE, FALSE, $4)`,
      [secondId, agentId, 'second', new Date('2026-01-02T00:00:00.000Z')]
    );

    const res = await request(app)
      .get(`/api/user/messages/${agentId}`)
      .query({ since: '2026-01-01T12:00:00.000Z' })
      .expect(200);

    const ids = res.body.messages.map((m) => m.messageId);
    expect(ids).toContain(secondId);
    expect(ids).not.toContain(firstId);

    await pool.end();
  });

  it('GET /api/user/messages/:agentId supports cursor polling across agent + user messages', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    const firstId = uuidv4();
    const secondId = uuidv4();
    const userMsgId = uuidv4();

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Alpha',
      1,
    ]);

    await query(
      `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response, created_at)
       VALUES ($1, $2, 'message', $3, 0, FALSE, FALSE, $4)`,
      [firstId, agentId, 'first', new Date('2026-01-01T00:00:00.000Z')]
    );
    await query(
      `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response, created_at)
       VALUES ($1, $2, 'message', $3, 2, TRUE, FALSE, $4)`,
      [secondId, agentId, 'second', new Date('2026-01-01T00:00:01.000Z')]
    );
    await query(
      `INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, created_at)
       VALUES ($1, $2, $3, FALSE, $4)`,
      [userMsgId, agentId, 'user says hi', new Date('2026-01-01T00:00:02.000Z')]
    );

    const initial = await request(app).get(`/api/user/messages/${agentId}`).expect(200);
    expect(initial.body.messages).toHaveLength(3);

    const firstCursor = initial.body.messages[0].cursor;
    expect(firstCursor).toBeDefined();

    const polled = await request(app)
      .get(`/api/user/messages/${agentId}`)
      .query({ cursor: String(firstCursor), since: '2026-01-01T00:00:00.000Z' })
      .expect(200);

    const ids = polled.body.messages.map((m) => m.messageId);
    expect(ids).toContain(secondId);
    expect(ids).toContain(userMsgId);
    expect(ids).not.toContain(firstId);

    const second = polled.body.messages.find((m) => m.messageId === secondId);
    expect(second).toMatchObject({ priority: 2, urgent: true, content: 'second' });

    await pool.end();
  });

  it('GET /api/user/messages/:agentId exposes runCommand for agent messages', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    const messageId = uuidv4();
    const runCommand = 'gemini --model gemini-2.5-pro -p -';

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Alpha',
      1,
    ]);
    await query(
      `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response, run_command, created_at)
       VALUES ($1, $2, 'message', $3, 0, FALSE, FALSE, $4, $5)`,
      [messageId, agentId, 'ran', runCommand, new Date('2026-01-01T00:00:00.000Z')]
    );

    const res = await request(app).get(`/api/user/messages/${agentId}`).expect(200);
    const message = res.body.messages.find((entry) => entry.messageId === messageId);

    expect(message).toBeTruthy();
    expect(message.runCommand).toBe(runCommand);

    await pool.end();
  });

  it('GET /api/user/messages/all includes runCommand for merged agent messages', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    const messageId = uuidv4();
    const runCommand = 'claude --model sonnet -p';

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Alpha',
      1,
    ]);
    await query(
      `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response, run_command, created_at)
       VALUES ($1, $2, 'message', $3, 0, FALSE, FALSE, $4, $5)`,
      [messageId, agentId, 'hello', runCommand, new Date('2026-01-01T00:00:00.000Z')]
    );

    const res = await request(app).get('/api/user/messages/all').expect(200);
    const message = res.body.messages.find((entry) => entry.messageId === messageId);

    expect(message).toBeTruthy();
    expect(message.runCommand).toBe(runCommand);

    await pool.end();
  });

  it('GET /api/user/messages/:agentId/status/:messageId marks timed-out unread messages as failed when agent is idle', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    const staleMsgId = uuidv4();
    const staleTimestamp = new Date(Date.now() - (3 * 60 * 1000));

    await query(
      `INSERT INTO agents (agent_id, user_id, agent_name, position, is_working, last_working_heartbeat_at)
       VALUES ($1, $2, $3, $4, FALSE, NULL)`,
      [agentId, userId, 'Alpha', 1]
    );

    await query(
      `INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, created_at, read_at)
       VALUES ($1, $2, $3, FALSE, $4, NULL)`,
      [staleMsgId, agentId, 'stale unread', staleTimestamp]
    );

    const failedStatus = await request(app)
      .get(`/api/user/messages/${agentId}/status/${staleMsgId}`)
      .expect(200);

    expect(failedStatus.body).toMatchObject({
      messageId: staleMsgId,
      readAt: null,
      deliveryState: 'failed',
      deliveryFailed: true,
      failedReason: 'agent_not_receiving'
    });

    await query(
      `UPDATE agents
       SET is_working = TRUE, last_working_heartbeat_at = $2
       WHERE agent_id = $1`,
      [agentId, new Date()]
    );

    const pendingWhileWorking = await request(app)
      .get(`/api/user/messages/${agentId}/status/${staleMsgId}`)
      .expect(200);

    expect(pendingWhileWorking.body).toMatchObject({
      messageId: staleMsgId,
      readAt: null,
      deliveryState: 'pending',
      deliveryFailed: false,
      failedReason: null
    });

    await pool.end();
  });

  it('GET /api/user/messages/:agentId/status returns multiple delivery states in one request', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    const staleMsgId = uuidv4();
    const readMsgId = uuidv4();
    const staleTimestamp = new Date(Date.now() - (3 * 60 * 1000));
    const readTimestamp = new Date();

    await query(
      `INSERT INTO agents (agent_id, user_id, agent_name, position, is_working, last_working_heartbeat_at)
       VALUES ($1, $2, $3, $4, FALSE, NULL)`,
      [agentId, userId, 'Alpha', 1]
    );

    await query(
      `INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, created_at, read_at)
       VALUES ($1, $2, $3, FALSE, $4, NULL)`,
      [staleMsgId, agentId, 'stale unread', staleTimestamp]
    );
    await query(
      `INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, created_at, read_at)
       VALUES ($1, $2, $3, FALSE, $4, $5)`,
      [readMsgId, agentId, 'read', staleTimestamp, readTimestamp]
    );

    const res = await request(app)
      .get(`/api/user/messages/${agentId}/status?ids=${staleMsgId},${readMsgId}`)
      .expect(200);

    expect(res.body.statuses).toHaveLength(2);
    expect(res.body.statuses[0]).toMatchObject({
      messageId: staleMsgId,
      readAt: null,
      deliveryState: 'failed',
      deliveryFailed: true,
      failedReason: 'agent_not_receiving'
    });
    expect(res.body.statuses[1]).toMatchObject({
      messageId: readMsgId,
      deliveryState: 'read',
      deliveryFailed: false,
      failedReason: null
    });
    expect(res.body.statuses[1].readAt).toBeTruthy();

    await pool.end();
  });

  it('GET /api/user/messages/:agentId returns delivery state metadata for user messages', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    const failedMsgId = uuidv4();
    const hiddenMsgId = uuidv4();
    const readMsgId = uuidv4();

    await query(
      `INSERT INTO agents (agent_id, user_id, agent_name, position, is_working, last_working_heartbeat_at)
       VALUES ($1, $2, $3, $4, FALSE, NULL)`,
      [agentId, userId, 'Alpha', 1]
    );

    await query(
      `INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, created_at, read_at, hidden_from_agent)
       VALUES ($1, $2, $3, FALSE, $4, NULL, FALSE)`,
      [failedMsgId, agentId, 'should fail', new Date(Date.now() - (5 * 60 * 1000))]
    );

    await query(
      `INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, created_at, read_at, hidden_from_agent)
       VALUES ($1, $2, $3, FALSE, $4, NULL, TRUE)`,
      [hiddenMsgId, agentId, 'hidden from agent', new Date(Date.now() - (5 * 60 * 1000))]
    );

    await query(
      `INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, created_at, read_at, hidden_from_agent)
       VALUES ($1, $2, $3, FALSE, $4, $5, FALSE)`,
      [readMsgId, agentId, 'already read', new Date(Date.now() - (5 * 60 * 1000)), new Date()]
    );

    const res = await request(app).get(`/api/user/messages/${agentId}`).expect(200);
    const byId = new Map(res.body.messages.filter((m) => m.type === 'user_message').map((m) => [m.messageId, m]));

    expect(byId.get(failedMsgId)).toMatchObject({
      deliveryState: 'failed',
      deliveryFailed: true,
      failedReason: 'agent_not_receiving'
    });
    expect(byId.get(hiddenMsgId)).toMatchObject({
      deliveryState: 'pending',
      deliveryFailed: false,
      failedReason: null
    });
    expect(byId.get(readMsgId)).toMatchObject({
      deliveryState: 'read',
      deliveryFailed: false,
      failedReason: null
    });

    await pool.end();
  });

  it('GET /api/user/messages/:agentId rejects invalid cursor values', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Alpha',
      1,
    ]);

    const res = await request(app).get(`/api/user/messages/${agentId}`).query({ cursor: 'not-a-number' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    await pool.end();
  });

  it('GET /api/user/messages/:agentId redacts queued self-update payloads from conversation', async () => {
    const { app, query, pool, userId } = await createUserApiTestContext();

    const agentId = uuidv4();
    const userMsgId = uuidv4();
    const queuedPayload = 'ivBase64:tagBase64:ciphertextBase64';
    const queuedContent = `__AGENT_UPDATE__:${queuedPayload}`;

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Updater',
      1,
    ]);
    await query(
      `INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, created_at)
       VALUES ($1, $2, $3, TRUE, $4)`,
      [userMsgId, agentId, queuedContent, new Date('2026-01-03T00:00:00.000Z')]
    );

    const res = await request(app).get(`/api/user/messages/${agentId}`).expect(200);
    const queued = res.body.messages.find((m) => m.messageId === userMsgId);

    expect(queued).toBeTruthy();
    expect(queued).toMatchObject({
      type: 'user_message',
      messageSubtype: 'queued_self_update',
      encrypted: false,
    });
    expect(queued.content).toMatch(/self-update package queued/i);
    expect(queued.content).not.toContain(queuedPayload);

    await pool.end();
  });
});
