/**
 * Tests for Agent Spawn Service
 * Covers: spawn validation, depth limits, fan-out limits, global cap,
 *         folder creation, self-termination, child re-parenting, lineage queries.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── pg-mem test database ───────────────────────────────────────────────────
const { createTestDatabase, applyRuntimeUserColumns, applyArchiveSchema, seedUser } = require('../utils/pgMemTestUtils');

let pool, queryFn, userId, mockChatspaceDir, cleanupDb;

/**
 * Apply the lineage migration columns (022) on top of the pg-mem schema.
 */
async function applyLineageMigration(q) {
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS spawn_depth INTEGER DEFAULT 0');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS initial_instructions TEXT');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS auto_spawned BOOLEAN DEFAULT FALSE');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS can_spawn BOOLEAN DEFAULT FALSE');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS inter_agent_mode VARCHAR(50) DEFAULT \'disabled\'');
}

beforeEach(async () => {
  jest.resetModules();

  // Real Postgres is required to verify row-lock/concurrent admission behavior.
  if (process.env.SHARED_TEST_DATABASE_URL) {
    const { Pool } = require('pg');
    const schemaName = 'spawn_test_' + require('crypto').randomUUID().replace(/-/g, '');
    const admin = new Pool({ connectionString: process.env.SHARED_TEST_DATABASE_URL });
    cleanupDb = () => admin.end();
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    pool = new Pool({ connectionString: process.env.SHARED_TEST_DATABASE_URL, application_name: schemaName, options: `-c search_path=${schemaName}` });
    queryFn = (sql, params) => pool.query(sql, params);
    cleanupDb = async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
      await admin.end();
    };
    await queryFn(fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8'));
  } else {
    const testDb = createTestDatabase();
    pool = testDb.pool;
    queryFn = testDb.query;
    cleanupDb = () => pool.end();
  }

  await applyRuntimeUserColumns(queryFn);
  await applyArchiveSchema(queryFn);
  await applyLineageMigration(queryFn);

  const seeded = await seedUser(queryFn);
  userId = seeded.userId;

  // Create a temp chatspace directory
  mockChatspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatspace-test-'));

  // Mock DB connection module
  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => queryFn(text, params),
    getClient: () => pool.connect(),
    pool,
  }));

  // Mock logger
  jest.doMock('../../src/utils/logger', () => ({
    logInfo: jest.fn(),
    logWarn: jest.fn(),
    logError: jest.fn(),
  }));

  // Set env for chatspace dir
  process.env.CHATSPACE_DIR = mockChatspaceDir;
});

afterEach(async () => {
  delete process.env.CHATSPACE_DIR;

  // Clean up temp dir
  try {
    fs.rmSync(mockChatspaceDir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }

  await cleanupDb();
  jest.resetModules();
  jest.clearAllMocks();
});

// ─── Helper: create an agent in DB ──────────────────────────────────────────
async function createAgent(name, overrides = {}) {
  const result = await queryFn(
    `INSERT INTO agents (user_id, agent_name, agent_type, position, spawn_depth, can_spawn, auto_spawned, parent_agent_id, inter_agent_mode)
     VALUES ($1, $2, 'standard', COALESCE((SELECT MAX(position)+1 FROM agents WHERE user_id=$1), 1),
             $3, $4, $5, $6, $7)
     RETURNING agent_id, agent_name, spawn_depth`,
    [
      userId,
      name,
      overrides.spawnDepth ?? 0,
      overrides.canSpawn ?? false,
      overrides.autoSpawned ?? false,
      overrides.parentAgentId ?? null,
      overrides.interAgentMode ?? 'disabled',
    ]
  );
  if (Object.hasOwn(overrides, 'lastSeenAt')) {
    await queryFn('UPDATE agents SET last_seen_at = $2 WHERE agent_id = $1', [result.rows[0].agent_id, overrides.lastSeenAt]);
  }
  return result.rows[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('agentSpawnService', () => {

  // ─── spawnAgent ─────────────────────────────────────────────────────────
  describe('spawnAgent', () => {

    it('should spawn a child agent with correct DB fields', async () => {
      const parent = await createAgent('coordinator', { canSpawn: true, spawnDepth: 0 });
      const { spawnAgent } = require('../../src/services/agentSpawnService');

      const child = await spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'security-reviewer',
        initialInstructions: 'Review auth module.',
        canSpawn: false,
      });

      expect(child.agentName).toBe('security-reviewer');
      expect(child.spawnDepth).toBe(1);
      expect(child.parentAgentId).toBe(parent.agent_id);

      // Verify DB row
      const dbRow = await queryFn('SELECT * FROM agents WHERE agent_id = $1', [child.agentId]);
      expect(dbRow.rows).toHaveLength(1);
      expect(dbRow.rows[0].auto_spawned).toBe(true);
      expect(dbRow.rows[0].initial_instructions).toBe('Review auth module.');
      expect(dbRow.rows[0].inter_agent_mode).toBe('listen_all');
    });

    it('inherits the creating agent groups by default', async () => {
      const parent = await createAgent('grouped-coordinator', { canSpawn: true });
      const group = await queryFn(
        `INSERT INTO agent_groups (user_id, group_name) VALUES ($1, $2)
         RETURNING group_id, group_name`,
        [userId, 'Engineering']
      );
      await queryFn(
        'INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2)',
        [group.rows[0].group_id, parent.agent_id]
      );

      const { spawnAgent } = require('../../src/services/agentSpawnService');
      const child = await spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'same-team-child',
        initialInstructions: 'Stay with the team.'
      });

      expect(child.groups).toEqual([{
        groupId: group.rows[0].group_id,
        groupName: 'Engineering'
      }]);
      const membership = await queryFn(
        'SELECT group_id FROM agent_group_members WHERE agent_id = $1',
        [child.agentId]
      );
      expect(membership.rows.map(row => row.group_id)).toEqual([group.rows[0].group_id]);
    });

    it('supports explicit group selection and an explicit ungrouped child', async () => {
      const parent = await createAgent('group-selector', { canSpawn: true });
      const groups = await Promise.all(['Engineering', 'Research'].map(name => queryFn(
        `INSERT INTO agent_groups (user_id, group_name) VALUES ($1, $2)
         RETURNING group_id, group_name`,
        [userId, name]
      )));
      await queryFn(
        'INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2)',
        [groups[0].rows[0].group_id, parent.agent_id]
      );

      const { spawnAgent } = require('../../src/services/agentSpawnService');
      const selected = await spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'research-child',
        initialInstructions: '',
        groupSelectors: [groups[1].rows[0].group_id]
      });
      expect(selected.groups.map(group => group.groupName)).toEqual(['Research']);

      const ungroupedParent = await createAgent('ungrouped-selector', { canSpawn: true });
      const ungrouped = await spawnAgent({
        userId,
        parentAgentId: ungroupedParent.agent_id,
        childAgentName: 'ungrouped-child',
        initialInstructions: '',
        groupSelectors: []
      });
      expect(ungrouped.groups).toEqual([]);
      const membership = await queryFn(
        'SELECT group_id FROM agent_group_members WHERE agent_id = $1',
        [ungrouped.agentId]
      );
      expect(membership.rows).toHaveLength(0);
    });

    it('should not create a server-side child folder and should persist runtime state in DB', async () => {
      const parent = await createAgent('coordinator', { canSpawn: true });
      const { spawnAgent, sanitizeFolderName } = require('../../src/services/agentSpawnService');

      const child = await spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'Task Worker',
        initialInstructions: 'Do stuff',
      });

      const folderName = sanitizeFolderName('Task Worker');
      const agentDir = path.join(mockChatspaceDir, folderName);
      expect(fs.existsSync(agentDir)).toBe(false);
      expect(child.loopPid).toBeNull();
      expect(child.runtime).toMatchObject({
        sameMachineAsParent: true,
        launchMode: 'local_only',
        serverSideLaunch: false
      });

      const dbRow = await queryFn(
        'SELECT runtime_config, allowed_permissions FROM agents WHERE agent_id = $1',
        [child.agentId]
      );
      expect(dbRow.rows[0].runtime_config).toBeTruthy();
      expect(dbRow.rows[0].allowed_permissions).toBeTruthy();
    });

    it('should allow overriding child project path and expose runtime metadata', async () => {
      const parent = await createAgent('coordinator', { canSpawn: true });
      const { spawnAgent } = require('../../src/services/agentSpawnService');
      const childProjectPath = '/remote/or/local/project/path';

      const child = await spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'Path Worker',
        initialInstructions: 'Use explicit directory',
        projectPath: childProjectPath,
      });

      expect(child.runtime).toBeDefined();
      expect(child.runtime.sameMachineAsParent).toBe(true);
      expect(child.runtime.projectPath).toBe(childProjectPath);

      const dbRow = await queryFn(
        'SELECT runtime_config FROM agents WHERE agent_id = $1',
        [child.agentId]
      );
      expect(dbRow.rows[0].runtime_config.project_path).toBe(childProjectPath);
    });

    it('aligns child provider and sandbox with inherited permissions when parent config is missing', async () => {
      const parent = await createAgent('coordinator', { canSpawn: true });
      const { spawnAgent, sanitizeFolderName } = require('../../src/services/agentSpawnService');

      const parentDir = path.join(mockChatspaceDir, sanitizeFolderName('coordinator'));
      const parentStateDir = path.join(parentDir, 'agent_state');
      fs.mkdirSync(parentStateDir, { recursive: true });
      fs.writeFileSync(path.join(parentDir, '.env'), 'USER_PASSWORD="test-password"\n');
      fs.writeFileSync(
        path.join(parentStateDir, 'allowed_permissions.json'),
        JSON.stringify({
          codex: { '--sandbox': ['workspace-write'] },
          inter_agent: { enabled: false, mode: 'disabled', groups: [] }
        }, null, 2)
      );

      await spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'permission-aligned-child',
        initialInstructions: 'inherit parent permission ceiling',
      });

      const childRow = await queryFn(
        'SELECT runtime_config, allowed_permissions FROM agents WHERE agent_name = $1 AND user_id = $2',
        ['permission-aligned-child', userId]
      );

      expect(childRow.rows[0].allowed_permissions.inter_agent).toMatchObject({ enabled: true, mode: 'listen_all' });
      expect(childRow.rows[0].runtime_config.model_provider).toBe('codex');
      expect(childRow.rows[0].runtime_config.sandbox_mode).toBe('workspace-write');
      expect(childRow.rows[0].allowed_permissions.codex['--sandbox']).toContain('workspace-write');
    });

    it('grants a safe default permission ceiling when the parent has no explicit permissions', async () => {
      const parent = await createAgent('coordinator', { canSpawn: true });
      const { spawnAgent } = require('../../src/services/agentSpawnService');

      await spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'safe-default-child',
        initialInstructions: 'inherit safe defaults',
      });

      const childRow = await queryFn(
        'SELECT runtime_config, allowed_permissions FROM agents WHERE agent_name = $1 AND user_id = $2',
        ['safe-default-child', userId]
      );

      const perms = childRow.rows[0].allowed_permissions;
      expect(childRow.rows[0].runtime_config.sandbox_mode).toBe('workspace-write');
      expect(perms.claude['--dangerously-skip-permissions']).toBe(false);
      expect(perms.codex['--dangerously-bypass-approvals-and-sandbox']).toBe(false);
      expect(perms.codex['--sandbox']).not.toContain('danger-full-access');
      expect(perms.gemini['--no-sandbox']).toBe(false);
      expect(perms.copilot['--allow-all']).toBe(false);
      expect(perms.antigravity['--dangerously-skip-permissions']).toBe(false);
    });

    it('should not validate project path against the server filesystem', async () => {
      const parent = await createAgent('coordinator', { canSpawn: true });
      const { spawnAgent } = require('../../src/services/agentSpawnService');

      const child = await spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'Bad Path Worker',
        initialInstructions: '',
        projectPath: '/definitely/not/a/real/dir',
      });

      expect(child.runtime.projectPath).toBe('/definitely/not/a/real/dir');
    });

    it('should reject spawn when parent has can_spawn = false', async () => {
      const parent = await createAgent('locked-agent', { canSpawn: false });
      const { spawnAgent } = require('../../src/services/agentSpawnService');

      await expect(spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'child1',
        initialInstructions: '',
      })).rejects.toThrow(/can_spawn/i);
    });

    it('should reject spawn when max depth reached', async () => {
      const parent = await createAgent('deep-agent', { canSpawn: true, spawnDepth: 3 });
      const { spawnAgent } = require('../../src/services/agentSpawnService');

      await expect(spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'too-deep',
        initialInstructions: '',
      })).rejects.toThrow(/depth/i);
    });

    it('should reject spawn when child name already exists', async () => {
      await createAgent('existing-name', {});
      const parent = await createAgent('spawner', { canSpawn: true });
      const { spawnAgent } = require('../../src/services/agentSpawnService');

      await expect(spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'existing-name',
        initialInstructions: '',
      })).rejects.toThrow(/already exists/i);
    });

    it('should reject option-like child names', async () => {
      const parent = await createAgent('spawner', { canSpawn: true });
      const { spawnAgent } = require('../../src/services/agentSpawnService');

      await expect(spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: '--help',
        initialInstructions: '',
      })).rejects.toThrow(/must not be empty or begin with "-"/i);
    });

    it('should reject spawn when fan-out limit exceeded', async () => {
      const parent = await createAgent('busy-parent', { canSpawn: true });
      const { spawnAgent, SPAWN_LIMITS } = require('../../src/services/agentSpawnService');

      // Create MAX_CHILDREN children directly in DB
      for (let i = 0; i < SPAWN_LIMITS.MAX_CHILDREN; i++) {
        await createAgent(`child-${i}`, { parentAgentId: parent.agent_id, spawnDepth: 1 });
      }

      await expect(spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'one-too-many',
        initialInstructions: '',
      })).rejects.toThrow(/children/i);
    });

    it('allows 99 active agents, blocks at 100, and frees the slot when a check-in expires', async () => {
      const parent = await createAgent('global-cap-parent', { canSpawn: true });
      const { validateSpawnRequest, SPAWN_LIMITS } = require('../../src/services/agentSpawnService');

      expect(SPAWN_LIMITS.GLOBAL_AGENT_CAP).toBe(100);

      let activeCount = Number((await queryFn(
        'SELECT COUNT(*)::int AS count FROM agents WHERE user_id = $1',
        [userId]
      )).rows[0].count);

      // Fill to 99 active agents, so one more spawn is valid.
      for (let i = 0; activeCount < SPAWN_LIMITS.GLOBAL_AGENT_CAP - 1; i++, activeCount++) {
        await createAgent(`global-cap-filler-${i}`);
      }

      const validAtCapMinusOne = await validateSpawnRequest(userId, parent.agent_id, 'agent-100');
      expect(validAtCapMinusOne).toMatchObject({ valid: true });

      await createAgent('agent-100');

      await expect(validateSpawnRequest(userId, parent.agent_id, 'agent-101')).resolves.toMatchObject({
        valid: false,
        error: expect.stringContaining('Global agent cap reached (100 active agents).')
      });

      await queryFn("UPDATE agents SET last_seen_at = NOW()::timestamp - INTERVAL '6 minutes' WHERE agent_name = 'agent-100' AND user_id = $1", [userId]);
      await expect(validateSpawnRequest(userId, parent.agent_id, 'replacement')).resolves.toMatchObject({ valid: true });
    });

    it('spawns despite more than 100 offline agents and preserves their saved chats', async () => {
      const parent = await createAgent('active-parent', { canSpawn: true });
      const { spawnAgent, SPAWN_LIMITS } = require('../../src/services/agentSpawnService');
      const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
      for (let i = 0; i < SPAWN_LIMITS.GLOBAL_AGENT_CAP + 1; i++) {
        await createAgent(`offline-${i}`, { lastSeenAt: i === 0 ? null : stale });
      }
      // A stale working flag must not keep a disconnected agent counted.
      await queryFn("UPDATE agents SET is_working = TRUE WHERE agent_name = 'offline-1'");
      const child = await spawnAgent({ userId, parentAgentId: parent.agent_id, childAgentName: 'new-active-child' });
      expect(child.agentName).toBe('new-active-child');
      const offline = await queryFn("SELECT COUNT(*)::int AS count FROM agents WHERE agent_name LIKE 'offline-%' AND user_id = $1", [userId]);
      expect(offline.rows[0].count).toBe(SPAWN_LIMITS.GLOBAL_AGENT_CAP + 1);
    });

    it('ignores offline children, counts idle connected children, and reserves fresh startup slots', async () => {
      const parent = await createAgent('fanout-parent', { canSpawn: true });
      const { spawnAgent, validateSpawnRequest, SPAWN_LIMITS } = require('../../src/services/agentSpawnService');
      const stale = new Date(Date.now() - 6 * 60 * 1000);
      for (let i = 0; i < SPAWN_LIMITS.MAX_CHILDREN + 1; i++) {
        await createAgent(`stale-child-${i}`, { parentAgentId: parent.agent_id, lastSeenAt: i === 0 ? null : stale });
      }
      for (let i = 0; i < SPAWN_LIMITS.MAX_CHILDREN - 1; i++) {
        await createAgent(`idle-child-${i}`, { parentAgentId: parent.agent_id });
      }
      const fresh = await spawnAgent({ userId, parentAgentId: parent.agent_id, childAgentName: 'starting-child' });
      await expect(validateSpawnRequest(userId, parent.agent_id, 'blocked-child')).resolves.toMatchObject({
        valid: false, error: expect.stringContaining('10 active children')
      });
      await queryFn('UPDATE agents SET last_seen_at = $2 WHERE agent_id = $1', [fresh.agentId, stale]);
      // Reset the cooldown by reloading the service; only admission is under test.
      jest.resetModules();
      const service = require('../../src/services/agentSpawnService');
      await expect(service.validateSpawnRequest(userId, parent.agent_id, 'replacement')).resolves.toMatchObject({ valid: true });
      await expect(service.validateSpawnRequest(userId, parent.agent_id, 'stale-child-0')).resolves.toMatchObject({
        valid: false, error: expect.stringContaining('already exists')
      });
    });

    it('excludes other accounts from the active cap', async () => {
      const parent = await createAgent('scoped-parent', { canSpawn: true });
      const { validateSpawnRequest, SPAWN_LIMITS } = require('../../src/services/agentSpawnService');
      const other = await seedUser(queryFn, { email: 'other-spawn@example.test' });
      for (let i = 0; i < SPAWN_LIMITS.GLOBAL_AGENT_CAP; i++) {
        await queryFn("INSERT INTO agents(user_id, agent_name, position) VALUES($1, $2, $3)", [other.userId, `other-${i}`, i]);
      }
      await expect(validateSpawnRequest(userId, parent.agent_id, 'my-child')).resolves.toMatchObject({ valid: true });
    });

    (process.env.SHARED_TEST_DATABASE_URL ? it : it.skip)('admits only one of two concurrent parents competing for the last active slot', async () => {
      const first = await createAgent('racing-parent-a', { canSpawn: true });
      const second = await createAgent('racing-parent-b', { canSpawn: true });
      const { spawnAgent, SPAWN_LIMITS } = require('../../src/services/agentSpawnService');
      const count = Number((await queryFn('SELECT COUNT(*)::int AS count FROM agents WHERE user_id = $1', [userId])).rows[0].count);
      for (let i = count; i < SPAWN_LIMITS.GLOBAL_AGENT_CAP - 1; i++) await createAgent(`racing-filler-${i}`);

      // Block both requests on the real account lock, then release together.
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT user_id FROM users WHERE user_id = $1 FOR NO KEY UPDATE', [userId]);
      const competing = Promise.allSettled([first, second].map((parent, i) => spawnAgent({
        userId, parentAgentId: parent.agent_id, childAgentName: `racing-child-${i}`
      })));
      let bothWaiting = false;
      try {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const waiting = await queryFn("SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND pid <> $2", [pool.options.application_name, blocker.processID]);
          if (waiting.rows[0].count === 2) { bothWaiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      const results = await competing;
      expect(bothWaiting).toBe(true);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(result => result.status === 'rejected').reason.message).toMatch(/Global agent cap/);
      const after = await queryFn('SELECT COUNT(*)::int AS count FROM agents WHERE user_id = $1', [userId]);
      expect(after.rows[0].count).toBe(SPAWN_LIMITS.GLOBAL_AGENT_CAP);
    }, 15000);

    it('should enforce spawn cooldown (rate limit)', async () => {
      const parent = await createAgent('fast-spawner', { canSpawn: true });
      const { spawnAgent } = require('../../src/services/agentSpawnService');

      // First spawn should succeed
      await spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'first-child',
        initialInstructions: '',
      });

      // Second spawn immediately should fail (cooldown)
      await expect(spawnAgent({
        userId,
        parentAgentId: parent.agent_id,
        childAgentName: 'second-child',
        initialInstructions: '',
      })).rejects.toThrow(/cooldown/i);
    });
  });

  // ─── selfTerminate ──────────────────────────────────────────────────────
  describe('selfTerminate', () => {

    it('should delete the agent and return success', async () => {
      const agent = await createAgent('disposable', { autoSpawned: true });
      const { selfTerminate } = require('../../src/services/agentSpawnService');

      const result = await selfTerminate({
        userId,
        agentId: agent.agent_id,
        reason: 'Task complete',
        archiveMessages: false,
      });

      expect(result.success).toBe(true);
      expect(result.agentName).toBe('disposable');

      // Agent should be gone from agents table
      const check = await queryFn('SELECT 1 FROM agents WHERE agent_id = $1', [agent.agent_id]);
      expect(check.rows).toHaveLength(0);
    });

    it('should re-parent children to grandparent on termination', async () => {
      const grandparent = await createAgent('grandparent', { canSpawn: true });
      const parent = await createAgent('parent-term', {
        canSpawn: true,
        spawnDepth: 1,
        parentAgentId: grandparent.agent_id,
      });
      const child = await createAgent('grandchild', {
        spawnDepth: 2,
        parentAgentId: parent.agent_id,
      });

      const { selfTerminate } = require('../../src/services/agentSpawnService');

      const result = await selfTerminate({
        userId,
        agentId: parent.agent_id,
        reason: 'Middle agent done',
        archiveMessages: false,
      });

      expect(result.orphanedChildren).toBe(1);
      expect(result.orphanAction).toBe('reassigned_to_parent');

      // Grandchild should now point to grandparent
      const childRow = await queryFn('SELECT parent_agent_id, spawn_depth FROM agents WHERE agent_id = $1', [child.agent_id]);
      expect(childRow.rows[0].parent_agent_id).toBe(grandparent.agent_id);
      expect(childRow.rows[0].spawn_depth).toBe(1); // decremented from 2
    });

    it('should promote children to root when terminating a root agent', async () => {
      const rootAgent = await createAgent('root-terminator', { canSpawn: true, spawnDepth: 0 });
      const child = await createAgent('orphan-child', {
        spawnDepth: 1,
        parentAgentId: rootAgent.agent_id,
      });

      const { selfTerminate } = require('../../src/services/agentSpawnService');

      const result = await selfTerminate({
        userId,
        agentId: rootAgent.agent_id,
        reason: 'Root retiring',
        archiveMessages: false,
      });

      expect(result.orphanAction).toBe('promoted_to_root');

      const childRow = await queryFn('SELECT parent_agent_id, spawn_depth FROM agents WHERE agent_id = $1', [child.agent_id]);
      expect(childRow.rows[0].parent_agent_id).toBeNull();
      expect(childRow.rows[0].spawn_depth).toBe(0);
    });

    it('should return AGENT_NOT_FOUND for non-existent agent', async () => {
      const { selfTerminate } = require('../../src/services/agentSpawnService');

      await expect(selfTerminate({
        userId,
        agentId: '00000000-0000-0000-0000-000000000000',
        reason: 'ghost',
        archiveMessages: false,
      })).rejects.toThrow(/not found/i);
    });
  });

  // ─── getLineage ─────────────────────────────────────────────────────────
  describe('getLineage', () => {

    it('should return ancestors and descendants', async () => {
      const root = await createAgent('root', { canSpawn: true, spawnDepth: 0 });
      const mid = await createAgent('mid', { spawnDepth: 1, parentAgentId: root.agent_id });
      const leaf = await createAgent('leaf', { spawnDepth: 2, parentAgentId: mid.agent_id });

      const { getLineage } = require('../../src/services/agentSpawnService');

      const lineage = await getLineage(mid.agent_id);

      // Ancestors of mid: root + mid itself
      const ancestorIds = lineage.ancestors.map(a => a.agent_id);
      expect(ancestorIds).toContain(root.agent_id);
      expect(ancestorIds).toContain(mid.agent_id);

      // Descendants of mid: leaf
      const descendantIds = lineage.descendants.map(d => d.agent_id);
      expect(descendantIds).toContain(leaf.agent_id);
    });
  });

  // ─── getChildren ────────────────────────────────────────────────────────
  describe('getChildren', () => {

    it('should return direct children only', async () => {
      const parent = await createAgent('parent-c', { canSpawn: true });
      const child1 = await createAgent('c1', { parentAgentId: parent.agent_id, spawnDepth: 1 });
      const child2 = await createAgent('c2', { parentAgentId: parent.agent_id, spawnDepth: 1 });
      const grandchild = await createAgent('gc1', { parentAgentId: child1.agent_id, spawnDepth: 2 });

      const { getChildren } = require('../../src/services/agentSpawnService');

      const children = await getChildren(parent.agent_id);
      expect(children).toHaveLength(2);
      const names = children.map(c => c.agent_name);
      expect(names).toContain('c1');
      expect(names).toContain('c2');
      // Grandchild should NOT appear
      expect(names).not.toContain('gc1');
    });
  });

  // ─── sanitizeFolderName ─────────────────────────────────────────────────
  describe('sanitizeFolderName', () => {
    it('should lowercase and replace special chars', () => {
      const { sanitizeFolderName } = require('../../src/services/agentSpawnService');
      expect(sanitizeFolderName('My Agent!')).toBe('my_agent_');
      expect(sanitizeFolderName('test-agent-1')).toBe('test-agent-1');
      expect(sanitizeFolderName('Hello World')).toBe('hello_world');
    });
  });

  describe('buildAgentLaunchEnv', () => {
    it('should include NVM bin directories and resolve CODEX_BIN', async () => {
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-env-home-'));
      const nvmBinDir = path.join(fakeHome, '.nvm', 'versions', 'node', 'v22.16.0', 'bin');
      fs.mkdirSync(nvmBinDir, { recursive: true });
      const codexPath = path.join(nvmBinDir, 'codex');
      fs.writeFileSync(codexPath, '#!/usr/bin/env bash\nexit 0\n');
      fs.chmodSync(codexPath, 0o755);

      const { buildAgentLaunchEnv } = require('../../src/services/agentSpawnService');
      const launchEnv = buildAgentLaunchEnv({
        HOME: fakeHome,
        PATH: '/usr/local/bin:/usr/bin:/bin'
      });

      const pathEntries = launchEnv.PATH.split(path.delimiter);
      expect(pathEntries).toContain(nvmBinDir);
      expect(launchEnv.CODEX_BIN).toBe(codexPath);

      fs.rmSync(fakeHome, { recursive: true, force: true });
    });
  });
});
