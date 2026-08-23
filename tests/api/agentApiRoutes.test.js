const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
        agentMessageIngressRateLimiter: (_req, _res, next) => next(),
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

  it('POST /api/agent/messages stores message without marking unread user messages as read', async () => {
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
    // newMessages should be empty — unread messages are only consumed via GET /agent/responses
    expect(res.body.newMessages).toHaveLength(0);

    // Unread user message must remain unread (not silently consumed)
    const unreadAfter = await query('SELECT read_at FROM user_messages WHERE user_message_id = $1', [unreadId]);
    expect(unreadAfter.rows[0].read_at).toBeNull();

    await pool.end();
  });

  it('second user message remains available after agent responds to first (regression)', async () => {
    // Reproduces the bug: user sends msg1 -> agent reads it via GET /responses ->
    // user sends msg2 while agent works -> agent posts response via POST /messages ->
    // msg2 must still be available on next GET /responses poll.
    const { app, query, pool, userId } = await createAgentApiTestContext();

    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId, userId, 'RegressionBot', 1,
    ]);

    // Step 1: User sends message 1
    const msg1Id = uuidv4();
    await query(
      'INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, read_at) VALUES ($1, $2, $3, FALSE, NULL)',
      [msg1Id, agentId, 'first task']
    );

    // Step 2: Agent polls via GET /responses — picks up msg1
    const poll1 = await request(app)
      .get('/api/agent/responses?agentName=RegressionBot')
      .expect(200);
    expect(poll1.body.responses.some(r => r.content === 'first task')).toBe(true);

    // msg1 should now be marked as read
    const msg1After = await query('SELECT read_at FROM user_messages WHERE user_message_id = $1', [msg1Id]);
    expect(msg1After.rows[0].read_at).toBeTruthy();

    // Step 3: While agent works on msg1, user sends message 2
    const msg2Id = uuidv4();
    await query(
      'INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, read_at) VALUES ($1, $2, $3, FALSE, NULL)',
      [msg2Id, agentId, 'second task']
    );

    // Step 4: Agent finishes and posts its response via POST /messages
    await request(app)
      .post('/api/agent/messages')
      .send({ agentName: 'RegressionBot', content: 'done with first task' })
      .expect(201);

    // Step 5: msg2 must still be unread
    const msg2After = await query('SELECT read_at FROM user_messages WHERE user_message_id = $1', [msg2Id]);
    expect(msg2After.rows[0].read_at).toBeNull();

    // Step 6: Next poll picks up msg2
    const poll2 = await request(app)
      .get('/api/agent/responses?agentName=RegressionBot')
      .expect(200);
    expect(poll2.body.responses.some(r => r.content === 'second task')).toBe(true);

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

  it('POST /api/agent/messages rejects rich_html placeholder stubs', async () => {
    const { app, pool } = await createAgentApiTestContext();

    await request(app)
      .post('/api/agent/messages')
      .send({
        agentName: 'PlaceholderBot',
        content: JSON.stringify({
          type: 'rich_html',
          title: 'REPLACE_WITH_TITLE',
          html: 'REPLACE_WITH_HTML',
        }),
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toMatch(/REPLACE_WITH_\*/);
      });

    await request(app)
      .post('/api/agent/messages')
      .send({
        agentName: 'PlaceholderBot',
        content: JSON.stringify({
          type: 'rich_html',
          title: '__REPLACE_WITH_TITLE__',
          html: '<div>__REPLACE_WITH_HTML__</div>',
        }),
      })
      .expect(400);

    // Old agent-runner.sh Option B verbatim stub — "Your Title" / "Your HTML here"
    await request(app)
      .post('/api/agent/messages')
      .send({
        agentName: 'PlaceholderBot',
        content: JSON.stringify({
          type: 'rich_html',
          title: 'Your Title',
          html: '<div>Your HTML here</div>',
        }),
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toMatch(/verbatim template stub/);
      });

    // Old Option A stub — "My Report" title used verbatim
    await request(app)
      .post('/api/agent/messages')
      .send({
        agentName: 'PlaceholderBot',
        content: JSON.stringify({
          type: 'rich_html',
          title: 'My Report',
          html: '<h1>Hello</h1>',
        }),
      })
      .expect(400);

    // Real content must pass through
    await request(app)
      .post('/api/agent/messages')
      .send({
        agentName: 'PlaceholderBot',
        content: JSON.stringify({
          type: 'rich_html',
          title: 'Agent Health Dashboard',
          html: '<div><h2>Status: OK</h2><p>All systems operational</p></div>',
        }),
      })
      .expect(201);

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

  it('GET /api/agent/responses records valid agentCliVersion reports', async () => {
    const { app, query, pool, userId } = await createAgentApiTestContext();

    const agentId = uuidv4();
    const userMessageId = uuidv4();

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'VersionReporter',
      1,
    ]);
    await query(
      'INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, read_at) VALUES ($1, $2, $3, FALSE, NULL)',
      [userMessageId, agentId, 'hello']
    );

    await request(app)
      .get('/api/agent/responses')
      .query({ agentName: 'VersionReporter', agentCliVersion: '1.2.3' })
      .expect(200);

    const first = await query(
      'SELECT reported_cli_version, reported_cli_version_at FROM agents WHERE agent_id = $1',
      [agentId]
    );
    expect(first.rows[0].reported_cli_version).toBe('1.2.3');
    expect(first.rows[0].reported_cli_version_at).toBeTruthy();

    await query(
      'INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, read_at) VALUES ($1, $2, $3, FALSE, NULL)',
      [uuidv4(), agentId, 'hello again']
    );

    await request(app)
      .get('/api/agent/responses')
      .query({ agentName: 'VersionReporter', agentCliVersion: 'not-a-version' })
      .expect(200);

    const second = await query('SELECT reported_cli_version FROM agents WHERE agent_id = $1', [agentId]);
    expect(second.rows[0].reported_cli_version).toBe('1.2.3');

    await pool.end();
  });

  it('GET /api/agent/responses returns self-update prompt metadata for queued updates', async () => {
    const { app, query, pool, userId } = await createAgentApiTestContext();

    const agentId = uuidv4();
    const userMessageId = uuidv4();
    const queuedPayload = 'ivBase64:tagBase64:ciphertextBase64';
    const queuedContent = `__AGENT_UPDATE__:${queuedPayload}`;

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      'UpdateAwareAgent',
      1,
    ]);
    await query(
      'INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, read_at) VALUES ($1, $2, $3, TRUE, NULL)',
      [userMessageId, agentId, queuedContent]
    );

    const res = await request(app).get('/api/agent/responses').query({ agentName: 'UpdateAwareAgent' }).expect(200);
    expect(res.body.responses).toHaveLength(1);
    expect(res.body.responses[0]).toMatchObject({
      responseType: 'text',
      from: 'system',
      encrypted: false,
      messageId: userMessageId,
    });
    expect(res.body.responses[0].content).toMatch(/update is available/i);
    expect(res.body.responses[0].updateAction).toEqual({
      type: 'queued_self_update',
      encryptedPayload: queuedPayload,
    });

    const messageRow = await query('SELECT read_at FROM user_messages WHERE user_message_id = $1', [userMessageId]);
    expect(messageRow.rows[0].read_at).toBeTruthy();

    await pool.end();
  });

  it('GET /api/agent/cli-script emits an additive X-Script-SHA256 header matching the body', async () => {
    jest.resetModules();
    const crypto = require('crypto');
    const apiKey = uuidv4();
    const encryptionSalt = 'a'.repeat(64);

    jest.doMock('../../src/db/connection', () => ({
      query: async () => ({ rows: [] }),
      getClient: async () => ({ release: () => {} }),
      pool: {},
    }));
    jest.doMock('../../src/utils/securityLogger', () => ({
      logApiKeyUsage: jest.fn(),
      logRateLimitViolation: jest.fn(),
    }));
    jest.doMock('../../src/middleware/authMiddleware', () => ({
      // Inject a fully-authenticated user so the route skips the salt-provision DB path.
      requireApiKey: (req, _res, next) => { req.user = { userId: uuidv4(), apiKey, encryptionSalt }; next(); },
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

    const res = await request(app).get('/api/agent/cli-script').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const expected = crypto.createHash('sha256').update(res.text, 'utf8').digest('hex');
    // Old clients ignore this header; new bootstrap clients verify it before chmod +x.
    expect(res.headers['x-script-sha256']).toBe(expected);
  });

  it('POST /api/agent/stop resolves agents stored under .chatspace', async () => {
    const { app, query, pool, userId } = await createAgentApiTestContext();

    const agentName = 'StopByDotChatspace';
    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId,
      userId,
      agentName,
      1,
    ]);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmcp-stop-'));
    const folderName = agentName.toLowerCase();
    const agentDir = path.join(tmpRoot, '.chatspace', folderName);
    fs.mkdirSync(path.join(agentDir, 'agent_state'), { recursive: true });

    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
    const homeBackup = process.env.HOME;
    process.env.HOME = path.join(tmpRoot, 'home');

    try {
      const res = await request(app)
        .post('/api/agent/stop')
        .send({ agentName })
        .expect(200);

      expect(res.body).toMatchObject({
        agentId,
        agentName,
      });

      const stopFlagPath = path.join(agentDir, 'agent_state', '.stop_requested');
      expect(fs.existsSync(stopFlagPath)).toBe(true);
      expect(fs.readFileSync(stopFlagPath, 'utf8').trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      cwdSpy.mockRestore();
      process.env.HOME = homeBackup;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      await pool.end();
    }
  });
});
