const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const { v4: uuidv4 } = require('uuid');

const { createTestDatabase, applyRuntimeUserColumns, seedUser, applyArchiveSchema } = require('../utils/pgMemTestUtils');

const schemaPath = path.join(__dirname, '../../src/db/schema.sql');

async function createTestContext() {
  jest.resetModules();
  const { pool, query } = createTestDatabase();

  // Mirror runtime columns expected by middleware
  await applyRuntimeUserColumns(query);
  await applyArchiveSchema(query);

  const { userId } = await seedUser(query, { emailVerified: true });

  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => query(text, params),
    pool
  }));

  jest.doMock('../../src/utils/securityLogger', () => ({
    logUnauthorizedAccess: jest.fn(),
    logApiKeyUsage: jest.fn()
  }));

  jest.doMock('../../src/utils/logger', () => ({
    logInfo: jest.fn(),
    logWarn: jest.fn(),
    logError: jest.fn()
  }));

  jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
    userPollingRateLimiter: (_req, _res, next) => next(),
    feedbackRateLimiter: (_req, _res, next) => next(),
  }));

  jest.doMock('../../src/services/ttsService', () => ({
    getAudioUrl: jest.fn().mockResolvedValue(null)
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

async function seedAgentWithData(query, userId, agentName = 'Alpha Agent') {
  const agentId = uuidv4();
  await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
    agentId,
    userId,
    agentName,
    1
  ]);

  const messageId = uuidv4();
  await query(
    `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response)
     VALUES ($1, $2, 'message', $3, 1, FALSE, FALSE)`,
    [messageId, agentId, 'hello']
  );

  const questionId = uuidv4();
  await query(
    `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent, allow_free_response)
     VALUES ($1, $2, 'question', $3, 0, FALSE, TRUE)`,
    [questionId, agentId, 'choose?']
  );

  const optionId = uuidv4();
  await query(
    `INSERT INTO question_options (option_id, message_id, option_text, benefits, downsides, is_default, option_order)
     VALUES ($1, $2, $3, $4, $5, TRUE, 1)`,
    [optionId, questionId, 'Yes', 'fast', 'none']
  );

  const responseId = uuidv4();
  await query(
    `INSERT INTO user_responses (response_id, message_id, option_id, free_response)
     VALUES ($1, $2, $3, $4)`,
    [responseId, questionId, optionId, 'ok']
  );

  const userMessageId = uuidv4();
  await query(
    `INSERT INTO user_messages (user_message_id, agent_id, content)
     VALUES ($1, $2, $3)`,
    [userMessageId, agentId, 'user says hi']
  );

  return { agentId, messageId, questionId, optionId, responseId, userMessageId };
}

describe('Agent deletion API', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('deletes an agent and cascades messages, options, responses, and user messages', async () => {
    const { app, query, pool, userId } = await createTestContext();
    const seeded = await seedAgentWithData(query, userId);

    const res = await request(app).delete(`/api/user/agents/${seeded.agentId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });

    const tables = [
      ['agents', 'agent_id', seeded.agentId],
      ['messages', 'message_id', seeded.messageId],
      ['messages', 'message_id', seeded.questionId],
      ['question_options', 'option_id', seeded.optionId],
      ['user_responses', 'response_id', seeded.responseId],
      ['user_messages', 'user_message_id', seeded.userMessageId]
    ];

    for (const [table, column, id] of tables) {
      const result = await query(`SELECT * FROM ${table} WHERE ${column} = $1`, [id]);
      expect(result.rowCount).toBe(0);
    }

    await pool.end();
  });

  it('keeps other agents intact and removes deleted agent from listings', async () => {
    const { app, query, pool, userId } = await createTestContext();
    const toDelete = await seedAgentWithData(query, userId, 'Delete Me');
    const keepId = uuidv4();

    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      keepId,
      userId,
      'Keep Me',
      2
    ]);
    const keepMessage = uuidv4();
    await query(
      `INSERT INTO messages (message_id, agent_id, message_type, content, priority, urgent)
       VALUES ($1, $2, 'message', $3, 0, FALSE)`,
      [keepMessage, keepId, 'still here']
    );

    await request(app).delete(`/api/user/agents/${toDelete.agentId}`).expect(200);

    const messages = await request(app).get(`/api/user/messages/${keepId}`).expect(200);
    expect(messages.body.messages).toHaveLength(1);
    expect(messages.body.messages[0]).toMatchObject({ messageId: keepMessage, content: 'still here' });

    const agents = await request(app).get('/api/user/agents').expect(200);
    const agentNames = agents.body.agents.map((a) => a.name);
    expect(agentNames).toContain('Keep Me');
    expect(agentNames).not.toContain('Delete Me');

    await pool.end();
  });

  it('documents cascading deletes for key relations in the schema', () => {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    const agentFkOccurrences =
      (schemaSql.match(/agent_id UUID NOT NULL REFERENCES agents\(agent_id\) ON DELETE CASCADE/g) || []).length;
    expect(agentFkOccurrences).toBeGreaterThanOrEqual(2); // messages + user_messages
    expect(schemaSql).toContain('message_id UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE');
    expect(schemaSql).toContain('option_id UUID REFERENCES question_options(option_id) ON DELETE CASCADE');
  });
});
