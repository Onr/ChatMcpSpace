const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTestDatabase, applyRuntimeUserColumns, seedUser, applyArchiveSchema } = require('../utils/pgMemTestUtils');

async function createDirectMessagesTestContext() {
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
        attachUserFromSession: (req, _res, next) => {
            req.user = { userId };
            next();
        },
    }));

    jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
        agentPollingRateLimiter: (_req, _res, next) => next(),
        agentApiRateLimiter: (_req, _res, next) => next(),
        agentMessageIngressRateLimiter: (_req, _res, next) => next(),
        feedbackRateLimiter: (_req, _res, next) => next(),
        userPollingRateLimiter: (_req, _res, next) => next(),
    }));

    const agentApiRoutes = require('../../src/routes/agentApiRoutes');
    const app = express();
    app.use(express.json());
    app.use('/api/agent', agentApiRoutes);
    app.use('/api/user', require('../../src/routes/userApiRoutes'));

    return { app, query, pool, userId };
}

describe('Agent Discovery API', () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it('GET /api/agent/discover returns all agents for user', async () => {
        const { app, query, pool, userId } = await createDirectMessagesTestContext();

        // Create two agents
        const agent1Id = uuidv4();
        const agent2Id = uuidv4();
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode, last_seen_at) VALUES ($1, $2, $3, $4, $5, NOW())', [
            agent1Id, userId, 'AgentAlpha', 1, 'listen_all',
        ]);
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode, last_seen_at) VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL \'10 minutes\')', [
            agent2Id, userId, 'AgentBeta', 2, 'listen_all',
        ]);

        const res = await request(app)
            .get('/api/agent/discover')
            .set('X-Agent-Name', 'AgentAlpha')
            .expect(200);

        expect(res.body.agents).toHaveLength(2);

        const alpha = res.body.agents.find(a => a.agentName === 'AgentAlpha');
        const beta = res.body.agents.find(a => a.agentName === 'AgentBeta');

        expect(alpha.isMe).toBe(true);
        expect(alpha.isOnline).toBe(true);
        expect(beta.isMe).toBe(false);
        expect(beta.isOnline).toBe(false);

        await pool.end();
    });
});

describe('Direct Messaging API - Send', () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it('POST /api/agent/messages/direct sends message to another agent', async () => {
        const { app, query, pool, userId } = await createDirectMessagesTestContext();

        // Create sender and recipient agents
        const senderId = uuidv4();
        const recipientId = uuidv4();
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [
            senderId, userId, 'SenderAgent', 1, 'listen_all',
        ]);
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [
            recipientId, userId, 'RecipientAgent', 2, 'listen_all',
        ]);

        const res = await request(app)
            .post('/api/agent/messages/direct')
            .set('X-Agent-Name', 'SenderAgent')
            .send({
                toAgentName: 'RecipientAgent',
                content: 'Hello from SenderAgent!',
                encrypted: true,
                priority: 1,
            })
            .expect(201);

        expect(res.body.status).toBe('sent');
        expect(res.body.messageId).toMatch(/^[a-f0-9-]{36}$/);
        expect(res.body.toAgent).toBe('RecipientAgent');
        expect(res.body.delivery).toMatchObject({
            mode: 'poll_only',
            recipientHost: 'remote_or_unregistered',
            wakeSignalSent: false
        });

        // Verify message was stored
        const msgResult = await query('SELECT * FROM agent_messages WHERE agent_message_id = $1', [res.body.messageId]);
        expect(msgResult.rows).toHaveLength(1);
        expect(msgResult.rows[0].content).toBe('Hello from SenderAgent!');
        expect(msgResult.rows[0].sender_agent_id).toBe(senderId);
        expect(msgResult.rows[0].recipient_agent_id).toBe(recipientId);

        await pool.end();
    });

    it('POST /api/agent/messages/direct reports instant wake when recipient has a local runner folder', async () => {
        const { app, query, pool, userId } = await createDirectMessagesTestContext();
        const originalChatspaceRoot = process.env.CHATSPACE_DIR;
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmcp-dm-'));

        try {
            process.env.CHATSPACE_DIR = tempRoot;
            fs.mkdirSync(path.join(tempRoot, 'recipientagent', 'agent_state'), { recursive: true });

            const senderId = uuidv4();
            const recipientId = uuidv4();
            await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [
                senderId, userId, 'SenderAgent', 1, 'listen_all',
            ]);
            await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [
                recipientId, userId, 'RecipientAgent', 2, 'listen_all',
            ]);

            const res = await request(app)
                .post('/api/agent/messages/direct')
                .set('X-Agent-Name', 'SenderAgent')
                .send({
                    toAgentName: 'RecipientAgent',
                    content: 'Wake up',
                    encrypted: true,
                    priority: 0,
                })
                .expect(201);

            expect(res.body.delivery).toMatchObject({
                mode: 'instant_wake',
                recipientHost: 'local',
                wakeSignalSent: true
            });

            const signalPath = path.join(tempRoot, 'recipientagent', 'agent_state', '.dm_pending');
            expect(fs.existsSync(signalPath)).toBe(true);
            expect(fs.readFileSync(signalPath, 'utf8')).toContain('from=SenderAgent');
        } finally {
            process.env.CHATSPACE_DIR = originalChatspaceRoot;
            fs.rmSync(tempRoot, { recursive: true, force: true });
            await pool.end();
        }
    });

    it('POST /api/agent/messages/direct rejects unencrypted messages', async () => {
        const { app, query, pool, userId } = await createDirectMessagesTestContext();

        const senderId = uuidv4();
        const recipientId = uuidv4();
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [
            senderId, userId, 'SenderAgent', 1, 'listen_all',
        ]);
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [
            recipientId, userId, 'RecipientAgent', 2, 'listen_all',
        ]);

        const res = await request(app)
            .post('/api/agent/messages/direct')
            .set('X-Agent-Name', 'SenderAgent')
            .send({
                toAgentName: 'RecipientAgent',
                content: 'Plaintext message',
            })
            .expect(400);

        expect(res.body.error.code).toBe('ENCRYPTION_REQUIRED');

        await pool.end();
    });

    it('POST /api/agent/messages/direct rejects self-messaging', async () => {
        const { app, query, pool, userId } = await createDirectMessagesTestContext();

        const agentId = uuidv4();
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [
            agentId, userId, 'SelfAgent', 1, 'listen_all',
        ]);

        const res = await request(app)
            .post('/api/agent/messages/direct')
            .set('X-Agent-Name', 'SelfAgent')
            .send({
                toAgentName: 'SelfAgent',
                content: 'Talking to myself',
            })
            .expect(400);

        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.message).toContain('Cannot send message to self');

        await pool.end();
    });

    it('POST /api/agent/messages/direct requires X-Agent-Name header', async () => {
        const { app, pool } = await createDirectMessagesTestContext();

        const res = await request(app)
            .post('/api/agent/messages/direct')
            .send({
                toAgentName: 'SomeAgent',
                content: 'Hello',
            })
            .expect(400);

        expect(res.body.error.message).toContain('X-Agent-Name header is required');

        await pool.end();
    });
});

describe('Direct Messaging API - Poll', () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it('GET /api/agent/messages/direct returns unread messages', async () => {
        const { app, query, pool, userId } = await createDirectMessagesTestContext();

        // Create two agents
        const senderId = uuidv4();
        const recipientId = uuidv4();
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [
            senderId, userId, 'SenderAgent', 1, 'listen_all',
        ]);
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [
            recipientId, userId, 'RecipientAgent', 2, 'listen_all',
        ]);

        // Insert a direct message
        const msgId = uuidv4();
        await query(
            'INSERT INTO agent_messages (agent_message_id, sender_agent_id, recipient_agent_id, content, priority) VALUES ($1, $2, $3, $4, $5)',
            [msgId, senderId, recipientId, 'Test message', 0]
        );

        const res = await request(app)
            .get('/api/agent/messages/direct')
            .set('X-Agent-Name', 'RecipientAgent')
            .expect(200);

        expect(res.body.messages).toHaveLength(1);
        expect(res.body.messages[0]).toMatchObject({
            messageId: msgId,
            fromAgent: 'SenderAgent',
            content: 'Test message',
            priority: 0,
        });

        // Verify message was marked as read
        const afterRead = await query('SELECT read_at FROM agent_messages WHERE agent_message_id = $1', [msgId]);
        expect(afterRead.rows[0].read_at).toBeTruthy();

        // Second poll should return empty (already read)
        const res2 = await request(app)
            .get('/api/agent/messages/direct')
            .set('X-Agent-Name', 'RecipientAgent')
            .expect(200);

        expect(res2.body.messages).toHaveLength(0);

        await pool.end();
    });

    it('GET /api/agent/messages/direct filters by fromAgent', async () => {
        const { app, query, pool, userId } = await createDirectMessagesTestContext();

        // Create three agents
        const agent1Id = uuidv4();
        const agent2Id = uuidv4();
        const agent3Id = uuidv4();
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [agent1Id, userId, 'Agent1', 1, 'listen_all']);
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [agent2Id, userId, 'Agent2', 2, 'listen_all']);
        await query('INSERT INTO agents (agent_id, user_id, agent_name, position, inter_agent_mode) VALUES ($1, $2, $3, $4, $5)', [agent3Id, userId, 'Agent3', 3, 'listen_all']);

        // Insert messages from both Agent1 and Agent2 to Agent3
        await query(
            'INSERT INTO agent_messages (sender_agent_id, recipient_agent_id, content, priority) VALUES ($1, $2, $3, $4)',
            [agent1Id, agent3Id, 'From Agent1', 0]
        );
        await query(
            'INSERT INTO agent_messages (sender_agent_id, recipient_agent_id, content, priority) VALUES ($1, $2, $3, $4)',
            [agent2Id, agent3Id, 'From Agent2', 0]
        );

        // Filter by Agent1 only
        const res = await request(app)
            .get('/api/agent/messages/direct')
            .set('X-Agent-Name', 'Agent3')
            .query({ fromAgent: 'Agent1' })
            .expect(200);

        expect(res.body.messages).toHaveLength(1);
        expect(res.body.messages[0].fromAgent).toBe('Agent1');
        expect(res.body.messages[0].content).toBe('From Agent1');

        await pool.end();
    });
});

describe('Direct message delivery confirmation', () => {
    afterEach(() => { jest.resetModules(); jest.clearAllMocks(); });
    it('reports an offline queue and keeps a DM until the actual recipient acknowledges it', async () => {
        const { app, query, pool, userId } = await createDirectMessagesTestContext();
        try {
            for (const name of ['Sender', 'Recipient', 'Other']) {
                await query('INSERT INTO agents (agent_id,user_id,agent_name,inter_agent_mode,position,last_seen_at) VALUES ($1,$2,$3,$4,0,NULL)', [uuidv4(), userId, name, 'listen_all']);
            }
            const sent = await request(app).post('/api/agent/messages/direct').set('X-Agent-Name', 'Sender')
                .send({ toAgentName: 'Recipient', content: 'encrypted task', encrypted: true }).expect(201);
            expect(sent.body.delivery).toMatchObject({ state: 'pending', recipientOnline: false, readAt: null });
            const messageId = sent.body.messageId;
            const dashboard = await request(app).get('/api/user/agent-messages').expect(200);
            expect(dashboard.body.messages[0].delivery).toMatchObject({ state: 'pending', recipientOnline: false });
            expect(dashboard.body.connections[0].pendingCount).toBe(1);
            for (let i = 0; i < 2; i++) {
                const polled = await request(app).get('/api/agent/messages/direct?markRead=false').set('X-Agent-Name', 'Recipient').expect(200);
                expect(polled.body.messages.map(m => m.messageId)).toContain(messageId);
            }
            await request(app).post('/api/agent/messages/direct/ack').set('X-Agent-Name', 'Other').send({ messageId }).expect(404);
            expect((await query('SELECT read_at FROM agent_messages WHERE agent_message_id=$1', [messageId])).rows[0].read_at).toBeNull();
            await request(app).post('/api/agent/messages/direct/ack').set('X-Agent-Name', 'Recipient').send({ messageId }).expect(200);
            const confirmed = await request(app).get('/api/user/agent-messages').expect(200);
            expect(confirmed.body.messages[0].delivery.state).toBe('received');
            expect(confirmed.body.connections[0].pendingCount).toBe(0);
            const polled = await request(app).get('/api/agent/messages/direct?markRead=false').set('X-Agent-Name', 'Recipient').expect(200);
            expect(polled.body.messages).toEqual([]);
        } finally { await pool.end(); }
    });

    it('does not call an online recipient delivery received before acknowledgement, including retries', async () => {
        const { app, query, pool, userId } = await createDirectMessagesTestContext();
        try {
            for (const name of ['Sender', 'Recipient']) {
                await query('INSERT INTO agents (agent_id,user_id,agent_name,inter_agent_mode,last_seen_at,position) VALUES ($1,$2,$3,$4,NOW(),0)', [uuidv4(), userId, name, 'listen_all']);
            }
            const body = { toAgentName: 'Recipient', content: 'encrypted task', encrypted: true, clientMessageId: uuidv4() };
            const send = () => request(app).post('/api/agent/messages/direct').set('X-Agent-Name', 'Sender').send(body);
            const sent = await send().expect(201);
            expect(sent.body.delivery).toMatchObject({ state: 'pending', recipientOnline: true });
            expect((await send().expect(200)).body.delivery.state).toBe('pending');
            await request(app).post('/api/agent/messages/direct/ack').set('X-Agent-Name', 'Recipient').send({ messageId: body.clientMessageId }).expect(200);
            expect((await send().expect(200)).body.delivery).toMatchObject({ state: 'received', readAt: expect.any(String) });
        } finally { await pool.end(); }
    });
});
