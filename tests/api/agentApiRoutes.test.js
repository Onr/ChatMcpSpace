const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const { createTestDatabase, applyRuntimeUserColumns, seedUser, applyArchiveSchema } = require('../utils/pgMemTestUtils');

async function createAgentApiTestContext() {
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
        feedbackRateLimiter: (_req, _res, next) => next(),
      }));

  const agentApiRoutes = require('../../src/routes/agentApiRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);

  return { app, query, pool, userId };
}

describe('Agent API routes', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('POST /api/agent/messages stores message and returns unread user messages', async () => {
    const { app, query, pool, userId } = await createAgentApiTestContext();

    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Alpha',
      1,
    ]);

    const unreadId = uuidv4();
    await query(
      'INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, read_at) VALUES ($1, $2, $3, FALSE, NULL)',
      [unreadId, agentId, 'hello from user']
    );

    const res = await request(app)
      .post('/api/agent/messages')
      .send({ agentName: 'Alpha', content: 'hello from agent' })
      .expect(201);

    expect(res.body.status).toBe('sent');
    expect(res.body.messageId).toMatch(/^[a-f0-9-]{36}$/);
    expect(res.body.newMessages).toHaveLength(1);
    expect(res.body.newMessages[0]).toMatchObject({
      messageId: unreadId,
      content: 'hello from user',
      encrypted: false,
    });

    const unreadAfter = await query('SELECT read_at FROM user_messages WHERE user_message_id = $1', [unreadId]);
    expect(unreadAfter.rows[0].read_at).toBeTruthy();

    await pool.end();
  });

  it('POST /api/agent/messages excludes hidden_from_agent messages from newMessages', async () => {
    const { app, query, pool, userId } = await createAgentApiTestContext();

    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'HiddenTestAgent',
      1,
    ]);

    // Create a visible unread message
    const visibleId = uuidv4();
    await query(
      'INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, read_at, hidden_from_agent) VALUES ($1, $2, $3, FALSE, NULL, FALSE)',
      [visibleId, agentId, 'visible message']
    );

    // Create a hidden unread message
    const hiddenId = uuidv4();
    await query(
      'INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, read_at, hidden_from_agent) VALUES ($1, $2, $3, FALSE, NULL, TRUE)',
      [hiddenId, agentId, 'hidden message']
    );

    const res = await request(app)
      .post('/api/agent/messages')
      .send({ agentName: 'HiddenTestAgent', content: 'hello from agent' })
      .expect(201);

    // Should only return the visible message, not the hidden one
    expect(res.body.newMessages).toHaveLength(1);
    expect(res.body.newMessages[0]).toMatchObject({
      messageId: visibleId,
      content: 'visible message',
    });

    // Visible message should be marked as read
    const visibleAfter = await query('SELECT read_at FROM user_messages WHERE user_message_id = $1', [visibleId]);
    expect(visibleAfter.rows[0].read_at).toBeTruthy();

    // Hidden message should NOT be marked as read (agent never saw it)
    const hiddenAfter = await query('SELECT read_at FROM user_messages WHERE user_message_id = $1', [hiddenId]);
    expect(hiddenAfter.rows[0].read_at).toBeNull();

    await pool.end();
  });

  it('POST /api/agent/messages validates input and supports priority/encryption', async () => {
    const { app, query, pool } = await createAgentApiTestContext();

    const invalid = await request(app).post('/api/agent/messages').send({ content: 'x' }).expect(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

    const ok = await request(app)
      .post('/api/agent/messages')
      .send({ agentName: 'Beta', content: 'urgent', priority: 2, encrypted: true })
      .expect(201);

    const messageRow = await query('SELECT priority, urgent, encrypted FROM messages WHERE message_id = $1', [
      ok.body.messageId,
    ]);
    expect(messageRow.rows[0]).toMatchObject({ priority: 2, urgent: true, encrypted: true });

    await pool.end();
  });

  it('POST /api/agent/questions creates a question with options', async () => {
    const { app, query, pool } = await createAgentApiTestContext();

    const res = await request(app)
      .post('/api/agent/questions')
      .send({
        agentName: 'Gamma',
        content: 'choose',
        options: [
          { text: 'A', benefits: 'fast', downsides: 'risk', isDefault: true },
          { text: 'B' },
        ],
        allowFreeResponse: false,
        encrypted: false,
      })
      .expect(201);

    expect(res.body.questionId).toMatch(/^[a-f0-9-]{36}$/);

    const messageRow = await query(
      'SELECT message_type, allow_free_response, encrypted FROM messages WHERE message_id = $1',
      [res.body.questionId]
    );
    expect(messageRow.rows[0]).toMatchObject({ message_type: 'question', allow_free_response: false, encrypted: false });

    const options = await query(
      'SELECT option_text, option_order, is_default FROM question_options WHERE message_id = $1 ORDER BY option_order ASC',
      [res.body.questionId]
    );
    expect(options.rows).toHaveLength(2);
    expect(options.rows[0]).toMatchObject({ option_text: 'A', option_order: 0, is_default: true });
    expect(options.rows[1]).toMatchObject({ option_text: 'B', option_order: 1, is_default: false });

    await pool.end();
  });

  it('GET /api/agent/responses returns unread replies and marks them read', async () => {
    const { app, query, pool, userId } = await createAgentApiTestContext();

    const agentId = uuidv4();
    const questionId = uuidv4();
    const responseId = uuidv4();
    const optionId = uuidv4();
    const userMessageId = uuidv4();

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'Delta',
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
    await query(
      'INSERT INTO user_responses (response_id, message_id, option_id, free_response, read_at) VALUES ($1, $2, $3, $4, NULL)',
      [responseId, questionId, optionId, 'ok']
    );
    await query(
      'INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, read_at) VALUES ($1, $2, $3, FALSE, NULL)',
      [userMessageId, agentId, 'free text']
    );

    const res = await request(app).get('/api/agent/responses').query({ agentName: 'Delta' }).expect(200);
    expect(res.body.responses).toHaveLength(2);
    const types = res.body.responses.map((r) => r.responseType);
    expect(types).toEqual(expect.arrayContaining(['option+open', 'text']));

    const responseRow = await query('SELECT read_at FROM user_responses WHERE response_id = $1', [responseId]);
    const messageRow = await query('SELECT read_at FROM user_messages WHERE user_message_id = $1', [userMessageId]);
    expect(responseRow.rows[0].read_at).toBeTruthy();
    expect(messageRow.rows[0].read_at).toBeTruthy();

    await pool.end();
  });

  it('GET /api/agent/responses supports since filtering (only unread after timestamp)', async () => {
    const { app, query, pool, userId } = await createAgentApiTestContext();

    const agentId = uuidv4();
    const questionId = uuidv4();
    const responseId = uuidv4();
    const optionId = uuidv4();
    const userMessageId = uuidv4();

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'SinceAgent',
      1,
    ]);

    await query(
      `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response, created_at)
       VALUES ($1, $2, 'question', $3, 0, FALSE, TRUE, $4)`,
      [questionId, agentId, 'q', new Date('2026-01-01T00:00:00.000Z')]
    );
    await query(
      `INSERT INTO question_options (option_id, message_id, option_text, benefits, downsides, is_default, option_order)
       VALUES ($1, $2, $3, NULL, NULL, TRUE, 0)`,
      [optionId, questionId, 'Yes']
    );
    await query(
      `INSERT INTO user_responses (response_id, message_id, option_id, free_response, read_at, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [responseId, questionId, optionId, 'early', new Date('2026-01-01T00:00:00.000Z')]
    );
    await query(
      `INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, read_at, created_at)
       VALUES ($1, $2, $3, FALSE, NULL, $4)`,
      [userMessageId, agentId, 'late', new Date('2026-01-02T00:00:00.000Z')]
    );

    const res = await request(app)
      .get('/api/agent/responses')
      .query({ agentName: 'SinceAgent', since: '2026-01-01T12:00:00.000Z' })
      .expect(200);

    expect(res.body.responses).toHaveLength(1);
    expect(res.body.responses[0]).toMatchObject({
      responseType: 'text',
      agentName: 'SinceAgent',
      messageId: userMessageId,
      content: 'late',
    });

    const optionRead = await query('SELECT read_at FROM user_responses WHERE response_id = $1', [responseId]);
    const textRead = await query('SELECT read_at FROM user_messages WHERE user_message_id = $1', [userMessageId]);
    expect(optionRead.rows[0].read_at).toBeNull();
    expect(textRead.rows[0].read_at).toBeTruthy();

    await pool.end();
  });
});
