/**
 * Tests for the Chief of Staff sub-router: /api/agent/cos/*
 *
 * Covers:
 *   - chiefOfStaffOnly middleware rejects non-CoS agents (403)
 *   - GET  /cos/roster
 *   - POST /cos/spawn-child (parent_agent_id set; folder written; auto-DM)
 *   - PATCH /cos/agents/:id/instructions (updates DB; CoS protected)
 *   - DELETE /cos/agents/:id (refuses self, refuses other CoS, requires confirmation)
 */

const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  createTestDatabase,
  applyRuntimeUserColumns,
  applyArchiveSchema,
  seedUser
} = require('../utils/pgMemTestUtils');

async function applyCosColumns(q) {
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_chief_of_staff BOOLEAN NOT NULL DEFAULT FALSE');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS spawn_depth INTEGER DEFAULT 0');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS initial_instructions TEXT');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS auto_spawned BOOLEAN DEFAULT FALSE');
}

async function makeCtx() {
  jest.resetModules();

  const { pool, query } = createTestDatabase();
  await applyRuntimeUserColumns(query);
  await applyArchiveSchema(query);
  await applyCosColumns(query);
  const { userId, apiKey } = await seedUser(query);

  const mockChatspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-api-test-'));
  process.env.CHATSPACE_DIR = mockChatspaceDir;

  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => query(text, params),
    getClient: () => pool.connect(),
    pool
  }));

  jest.doMock('../../src/utils/logger', () => ({
    logInfo: jest.fn(),
    logWarn: jest.fn(),
    logError: jest.fn()
  }));

  jest.doMock('../../src/utils/securityLogger', () => ({
    logApiKeyUsage: jest.fn(),
    logRateLimitViolation: jest.fn()
  }));

  jest.doMock('../../src/middleware/authMiddleware', () => ({
    requireApiKey: (req, _res, next) => {
      req.user = { userId, encryptionSalt: 'salt' };
      next();
    }
  }));

  jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
    agentPollingRateLimiter: (_req, _res, next) => next(),
    agentApiRateLimiter: (_req, _res, next) => next(),
    agentMessageIngressRateLimiter: (_req, _res, next) => next(),
    feedbackRateLimiter: (_req, _res, next) => next()
  }));

  jest.doMock('../../src/services/archiveService', () => ({
    archiveAgent: jest.fn(async () => undefined),
    isAgentArchived: jest.fn(async () => false)
  }));

  const agentApiRoutes = require('../../src/routes/agentApiRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);

  return { app, query, pool, userId, apiKey, mockChatspaceDir };
}

async function insertAgent(query, userId, { name, isCos = false, position = 1, canSpawn = true, parentId = null, spawnDepth = 0 }) {
  const id = uuidv4();
  await query(
    `INSERT INTO agents (agent_id, user_id, agent_name, agent_type, position,
                         is_chief_of_staff, can_spawn, inter_agent_mode,
                         parent_agent_id, spawn_depth)
     VALUES ($1, $2, $3, 'standard', $4, $5, $6, 'listen_all', $7, $8)`,
    [id, userId, name, position, isCos, canSpawn, parentId, spawnDepth]
  );
  return id;
}

describe('Chief of Staff sub-router (/api/agent/cos/*)', () => {

  afterEach(async () => {
    delete process.env.CHATSPACE_DIR;
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('rejects non-CoS agent with 403 on /cos/roster', async () => {
    const { app, query, pool, userId } = await makeCtx();
    await insertAgent(query, userId, { name: 'helper-1', isCos: false });

    const res = await request(app)
      .get('/api/agent/cos/roster')
      .set('X-Agent-Name', 'helper-1')
      .expect(403);

    expect(res.body.error.code).toBe('COS_FORBIDDEN');
    await pool.end();
  });

  it('returns the roster for a real CoS', async () => {
    const { app, query, pool, userId } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    await insertAgent(query, userId, { name: 'helper-1', isCos: false, position: 2 });

    const res = await request(app)
      .get('/api/agent/cos/roster')
      .set('X-Agent-Name', 'Chief of Staff')
      .expect(200);

    expect(res.body.cosAgentName).toBe('Chief of Staff');
    expect(res.body.agents).toHaveLength(2);
    expect(res.body.agents[0].is_chief_of_staff).toBe(true);
    expect(res.body.agents[1].agent_name).toBe('helper-1');
    await pool.end();
  });

  it('creates groups idempotently and adds a managed agent to one', async () => {
    const { app, query, pool, userId } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const helperId = await insertAgent(query, userId, { name: 'researcher', position: 2 });

    const created = await request(app)
      .post('/api/agent/cos/groups')
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ groupName: 'research', description: 'Research team' })
      .expect(201);
    expect(created.body.created).toBe(true);

    const replay = await request(app)
      .post('/api/agent/cos/groups')
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ groupName: 'research' })
      .expect(200);
    expect(replay.body.created).toBe(false);
    expect(replay.body.groupId).toBe(created.body.groupId);

    const joined = await request(app)
      .post(`/api/agent/cos/groups/${created.body.groupId}/members`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ agentId: helperId })
      .expect(200);
    expect(joined.body.joined).toBe(true);

    const repeatedJoin = await request(app)
      .post(`/api/agent/cos/groups/${created.body.groupId}/members`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ agentId: helperId })
      .expect(200);
    expect(repeatedJoin.body.joined).toBe(false);

    const roster = await request(app)
      .get('/api/agent/cos/roster')
      .set('X-Agent-Name', 'Chief of Staff')
      .expect(200);
    expect(roster.body.agents.find((agent) => agent.agent_id === helperId).groups)
      .toEqual([{ group_id: created.body.groupId, group_name: 'research' }]);

    await pool.end();
  });

  it('POST /cos/spawn-child creates a child with parent=CoS and writes the folder', async () => {
    const { app, query, pool, userId, mockChatspaceDir } = await makeCtx();
    const cosId = await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const group = await query(
      `INSERT INTO agent_groups (user_id, group_name) VALUES ($1, $2)
       RETURNING group_id`,
      [userId, 'Operations']
    );
    await query(
      'INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2)',
      [group.rows[0].group_id, cosId]
    );

    const res = await request(app)
      .post('/api/agent/cos/spawn-child')
      .set('X-Agent-Name', 'Chief of Staff')
      .set('X-Api-Key', 'k')
      .send({ name: 'research-agent', role: 'Scrape web', initialInstructions: 'Find docs' })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.childAgent.agentName).toBe('research-agent');
    expect(res.body.childAgent.parentAgentId).toBe(cosId);
    expect(res.body.childAgent.groups).toEqual([{
      groupId: group.rows[0].group_id,
      groupName: 'Operations'
    }]);
    expect(res.body.childAgent.tmuxLaunchCommand).toMatch(/tmux new-session/);

    // DB row exists with the right parent
    const dbRow = await query('SELECT agent_name, parent_agent_id FROM agents WHERE agent_name = $1', ['research-agent']);
    expect(dbRow.rows[0].parent_agent_id).toBe(cosId);

    // Files were written
    const expectedDir = path.join(mockChatspaceDir, 'research-agent');
    expect(fs.existsSync(path.join(expectedDir, 'AGENT_INSTRUCTIONS.md'))).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, 'agent-runner.sh'))).toBe(true);

    // Auto-DM was inserted into agent_messages
    const dms = await query(
      `SELECT content FROM agent_messages WHERE sender_agent_id = $1`,
      [cosId]
    );
    expect(dms.rows.length).toBeGreaterThan(0);
    expect(dms.rows[0].content).toContain('Find docs');

    await pool.end();
  });

  it('POST /cos/spawn-child rejects empty name', async () => {
    const { app, query, pool, userId } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true });
    const res = await request(app)
      .post('/api/agent/cos/spawn-child')
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ name: '   ' })
      .expect(400);
    expect(res.body.error.message).toMatch(/name is required/i);
    await pool.end();
  });

  it('PATCH /cos/agents/:id/instructions updates DB and refuses on another CoS', async () => {
    const { app, query, pool, userId } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const helperId = await insertAgent(query, userId, { name: 'helper', isCos: false, position: 2 });
    const anotherCosId = await insertAgent(query, userId, { name: 'Other Boss', isCos: true, position: 3 });

    // Happy path on a normal agent
    const res = await request(app)
      .patch(`/api/agent/cos/agents/${helperId}/instructions`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ newInstructions: 'You now do X.' })
      .expect(200);
    expect(res.body.success).toBe(true);

    const row = await query('SELECT initial_instructions FROM agents WHERE agent_id = $1', [helperId]);
    expect(row.rows[0].initial_instructions).toBe('You now do X.');

    // Forbidden: cannot edit another CoS
    const blocked = await request(app)
      .patch(`/api/agent/cos/agents/${anotherCosId}/instructions`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ newInstructions: 'X' })
      .expect(403);
    expect(blocked.body.error.code).toBe('COS_PROTECTED');

    await pool.end();
  });

  it('PATCH /cos/agents/:id/instructions writes new text to on-disk AGENT_INSTRUCTIONS.md', async () => {
    const { app, query, pool, userId, mockChatspaceDir } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const helperId = await insertAgent(query, userId, { name: 'helper-edit', isCos: false, position: 2 });

    // Seed an existing AGENT_INSTRUCTIONS.md so we can confirm it is overwritten.
    const helperDir = path.join(mockChatspaceDir, 'helper-edit');
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(path.join(helperDir, 'AGENT_INSTRUCTIONS.md'), 'OLD INSTRUCTIONS');

    const res = await request(app)
      .patch(`/api/agent/cos/agents/${helperId}/instructions`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ newInstructions: 'BRAND NEW INSTRUCTIONS' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.instructions_file_updated).toBe(true);
    expect(res.body.applied_immediately).toBe(true);
    expect(res.body.restart_requested).toBe(false);

    const written = fs.readFileSync(path.join(helperDir, 'AGENT_INSTRUCTIONS.md'), 'utf8');
    expect(written).toBe('BRAND NEW INSTRUCTIONS');

    await pool.end();
  });

  it('PATCH /cos/agents/:id/instructions writes .restart_requested when restart=true', async () => {
    const { app, query, pool, userId, mockChatspaceDir } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const helperId = await insertAgent(query, userId, { name: 'helper-restart', isCos: false, position: 2 });

    const res = await request(app)
      .patch(`/api/agent/cos/agents/${helperId}/instructions`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ newInstructions: 'Updated.', restart: true })
      .expect(200);

    expect(res.body.restart_requested).toBe(true);
    const signalPath = path.join(mockChatspaceDir, 'helper-restart', 'agent_state', '.restart_requested');
    expect(fs.existsSync(signalPath)).toBe(true);
    expect(fs.readFileSync(signalPath, 'utf8')).toMatch(/T\d{2}:\d{2}/);

    await pool.end();
  });

  it('POST /cos/spawn-child returns a tmuxLaunchCommand using double-quoted dir', async () => {
    const { app, query, pool, userId } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });

    const res = await request(app)
      .post('/api/agent/cos/spawn-child')
      .set('X-Agent-Name', 'Chief of Staff')
      .set('X-Api-Key', 'k')
      .send({ name: 'quote-check-agent', role: 'r', initialInstructions: 'i' })
      .expect(201);

    const cmd = res.body.childAgent.tmuxLaunchCommand;
    expect(cmd).toMatch(/^tmux new-session -d -s "quote-check-agent" /);
    // Path must be embedded with escaped double quotes inside the outer
    // double-quoted command, not naked single quotes around the path.
    expect(cmd).not.toMatch(/cd '/);
    expect(cmd).toMatch(/cd \\"/);

    await pool.end();
  });

  it('PATCH /cos/agents/:id/instructions rejects empty newInstructions', async () => {
    const { app, query, pool, userId } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const helperId = await insertAgent(query, userId, { name: 'helper', isCos: false, position: 2 });

    await request(app)
      .patch(`/api/agent/cos/agents/${helperId}/instructions`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ newInstructions: '' })
      .expect(400);

    await pool.end();
  });

  it('DELETE /cos/agents/:id refuses without the correct confirmation', async () => {
    const { app, query, pool, userId } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const helperId = await insertAgent(query, userId, { name: 'helper', isCos: false, position: 2 });

    const res = await request(app)
      .delete(`/api/agent/cos/agents/${helperId}`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ confirmation: 'WRONG' })
      .expect(400);
    expect(res.body.error.code).toBe('COS_CONFIRMATION_REQUIRED');

    await pool.end();
  });

  it('archives, clears, and reorders agents the CoS created, but not other agents', async () => {
    const { app, query, pool, userId } = await makeCtx();
    const cosId = await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const childId = await insertAgent(query, userId, { name: 'child', position: 2, parentId: cosId, spawnDepth: 1 });
    const grandchildId = await insertAgent(query, userId, { name: 'grandchild', position: 3, parentId: childId, spawnDepth: 2 });
    const manualId = await insertAgent(query, userId, { name: 'manual', position: 4 });
    await query(
      `INSERT INTO user_messages (agent_id, content) VALUES ($1, 'hello')`,
      [grandchildId]
    );

    const cleared = await request(app)
      .delete(`/api/agent/cos/agents/${grandchildId}/messages`)
      .set('X-Agent-Name', 'Chief of Staff')
      .expect(200);
    expect(cleared.body.deletedCount).toBe(1);

    await request(app)
      .put('/api/agent/cos/agents/positions')
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ updates: [{ agentId: childId, position: 7 }] })
      .expect(200);
    const moved = await query('SELECT position FROM agents WHERE agent_id = $1', [childId]);
    expect(moved.rows[0].position).toBe(7);

    const denied = await request(app)
      .post(`/api/agent/cos/agents/${manualId}/archive`)
      .set('X-Agent-Name', 'Chief of Staff')
      .expect(403);
    expect(denied.body.error.code).toBe('COS_NOT_CREATOR');
    await request(app)
      .put('/api/agent/cos/agents/positions')
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ updates: [{ agentId: manualId, position: 1 }] })
      .expect(403);

    const archived = await request(app)
      .post(`/api/agent/cos/agents/${childId}/archive`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ reason: 'done' })
      .expect(200);
    expect(archived.body.archived).toBe(true);
    const { archiveAgent } = require('../../src/services/archiveService');
    expect(archiveAgent).toHaveBeenCalledWith(userId, childId, 'done');
    const reparented = await query('SELECT parent_agent_id FROM agents WHERE agent_id = $1', [grandchildId]);
    expect(reparented.rows[0].parent_agent_id).toBe(cosId);

    await pool.end();
  });

  it('DELETE /cos/agents/:id refuses to delete the CoS itself', async () => {
    const { app, query, pool, userId } = await makeCtx();
    const cosId = await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });

    const res = await request(app)
      .delete(`/api/agent/cos/agents/${cosId}`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ confirmation: 'Chief of Staff' })
      .expect(403);
    expect(res.body.error.code).toBe('COS_SELF_DELETE');

    await pool.end();
  });

  it('DELETE /cos/agents/:id refuses to delete another CoS', async () => {
    const { app, query, pool, userId } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const otherCosId = await insertAgent(query, userId, { name: 'Other Boss', isCos: true, position: 2 });

    const res = await request(app)
      .delete(`/api/agent/cos/agents/${otherCosId}`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ confirmation: 'Other Boss' })
      .expect(403);
    expect(res.body.error.code).toBe('COS_PROTECTED');

    await pool.end();
  });

  it('PATCH /cos/agents/:id/config sets provider+model, persists to DB, and syncs the local config file', async () => {
    const { app, query, pool, userId, mockChatspaceDir } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const helperId = await insertAgent(query, userId, { name: 'helper-model', isCos: false, position: 2 });

    // Existing local agent folder → the endpoint should refresh its agent_config.json
    const helperState = path.join(mockChatspaceDir, 'helper-model', 'agent_state');
    fs.mkdirSync(helperState, { recursive: true });

    const res = await request(app)
      .patch(`/api/agent/cos/agents/${helperId}/config`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ model_provider: 'claude', model: 'claude-fable-5' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.config.model_provider).toBe('claude');
    expect(res.body.config.model).toBe('claude-fable-5');
    expect(res.body.applies_on_next_iteration).toBe(true);
    expect(res.body.config_file_updated).toBe(true);

    const row = await query('SELECT runtime_config FROM agents WHERE agent_id = $1', [helperId]);
    const stored = typeof row.rows[0].runtime_config === 'string'
      ? JSON.parse(row.rows[0].runtime_config)
      : row.rows[0].runtime_config;
    expect(stored.model_provider).toBe('claude');
    expect(stored.model).toBe('claude-fable-5');

    const fileCfg = JSON.parse(fs.readFileSync(path.join(helperState, 'agent_config.json'), 'utf8'));
    expect(fileCfg.model_provider).toBe('claude');
    expect(fileCfg.model).toBe('claude-fable-5');

    await pool.end();
  });

  it('PATCH /cos/agents/:id/config with model only keeps the current provider (backwards compatible)', async () => {
    const { app, query, pool, userId } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const helperId = await insertAgent(query, userId, { name: 'helper-model-only', isCos: false, position: 2 });
    await query(
      `UPDATE agents SET runtime_config = $2 WHERE agent_id = $1`,
      [helperId, JSON.stringify({ model_provider: 'gemini', model: 'gemini-2.5-pro' })]
    );

    const res = await request(app)
      .patch(`/api/agent/cos/agents/${helperId}/config`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ model: 'gemini-2.5-flash' })
      .expect(200);

    expect(res.body.config.model_provider).toBe('gemini');
    expect(res.body.config.model).toBe('gemini-2.5-flash');
    // No local folder for this agent → DB-only update, applied via API poll
    expect(res.body.config_file_updated).toBe(false);

    await pool.end();
  });

  it('PATCH /cos/agents/:id/config validates input, target, and permissions', async () => {
    const { app, query, pool, userId } = await makeCtx();
    await insertAgent(query, userId, { name: 'Chief of Staff', isCos: true, position: 1 });
    const helperId = await insertAgent(query, userId, { name: 'helper-guard', isCos: false, position: 2 });
    const otherCosId = await insertAgent(query, userId, { name: 'Other Boss', isCos: true, position: 3 });

    // Empty body
    const empty = await request(app)
      .patch(`/api/agent/cos/agents/${helperId}/config`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({})
      .expect(400);
    expect(empty.body.error.message).toMatch(/model_provider and\/or model/i);

    // Unknown provider
    const badProvider = await request(app)
      .patch(`/api/agent/cos/agents/${helperId}/config`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ model_provider: 'not-a-provider' })
      .expect(400);
    expect(badProvider.body.error.code).toBe('UNSUPPORTED_PROVIDER');

    // Unknown agent
    await request(app)
      .patch(`/api/agent/cos/agents/${uuidv4()}/config`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ model_provider: 'claude' })
      .expect(404);

    // Another CoS is protected
    const blocked = await request(app)
      .patch(`/api/agent/cos/agents/${otherCosId}/config`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ model_provider: 'claude' })
      .expect(403);
    expect(blocked.body.error.code).toBe('COS_PROTECTED');

    // Provider not in the target's allowed permissions
    await query(
      `UPDATE agents SET allowed_permissions = $2 WHERE agent_id = $1`,
      [helperId, JSON.stringify({ codex: { '--sandbox': ['workspace-write'] } })]
    );
    const denied = await request(app)
      .patch(`/api/agent/cos/agents/${helperId}/config`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ model_provider: 'claude' })
      .expect(400);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect(denied.body.error.allowedProviders).toContain('codex');

    // An allowed provider still goes through
    const ok = await request(app)
      .patch(`/api/agent/cos/agents/${helperId}/config`)
      .set('X-Agent-Name', 'Chief of Staff')
      .send({ model_provider: 'codex', model: 'gpt-5.6-terra' })
      .expect(200);
    expect(ok.body.config.model_provider).toBe('codex');

    await pool.end();
  });

  it('rejects when X-Agent-Name header is missing', async () => {
    const { app, pool } = await makeCtx();
    const res = await request(app)
      .get('/api/agent/cos/roster')
      .expect(400);
    expect(res.body.error.code).toBe('COS_AGENT_NAME_REQUIRED');
    await pool.end();
  });
});
