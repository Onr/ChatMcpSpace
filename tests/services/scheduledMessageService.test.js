const { v4: uuidv4 } = require('uuid');
const { createTestDatabase, applyRuntimeUserColumns, applyArchiveSchema, seedUser } = require('../utils/pgMemTestUtils');

describe('scheduledMessageService', () => {
  afterEach(() => jest.resetModules());

  it('delivers due messages exactly once into the regular user message queue', async () => {
    jest.resetModules();
    const { pool, query } = createTestDatabase();
    await applyRuntimeUserColumns(query);
    await applyArchiveSchema(query);
    const { userId } = await seedUser(query);
    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
      agentId, userId, 'Scheduled Alpha', 1,
    ]);
    await query(
      `INSERT INTO scheduled_user_messages (user_id, agent_id, content, scheduled_for, run_overrides)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [userId, agentId, 'due now', new Date(Date.now() - 1000), JSON.stringify({ model_provider: 'gemini', model: 'gemini-3.1-pro' })]
    );

    jest.doMock('../../src/db/connection', () => ({ getClient: () => pool.connect() }));
    const { deliverDueScheduledMessages } = require('../../src/services/scheduledMessageService');
    await expect(deliverDueScheduledMessages()).resolves.toBe(1);
    await expect(deliverDueScheduledMessages()).resolves.toBe(0);

    const messages = await query('SELECT content, run_overrides FROM user_messages WHERE agent_id = $1', [agentId]);
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0].content).toBe('due now');
    expect(messages.rows[0].run_overrides).toEqual({ model_provider: 'gemini', model: 'gemini-3.1-pro' });
    await pool.end();
  });
});
