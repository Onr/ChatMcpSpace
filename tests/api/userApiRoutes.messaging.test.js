const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const { createTestDatabase, applyRuntimeUserColumns, seedUser } = require('../utils/pgMemTestUtils');

async function createUserApiTestContext() {
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

  it('POST /api/user/messages forbids sending to agents not owned by the user', async () => {
    const { app, query, pool } = await createUserApiTestContext();

    const otherUserId = uuidv4();
    await query(
      'INSERT INTO users (user_id, email, password_hash, api_key, encryption_salt, email_verified) VALUES ($1, $2, $3, $4, $5, TRUE)',
      [otherUserId, 'other@example.com', 'hash', 'api-key-2', 'salt']
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
});
