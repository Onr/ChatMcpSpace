/**
 * Tests for chiefOfStaffService.
 * Covers: install (success + duplicate + name conflict), roster query,
 *         folder writing, isChiefOfStaff lookup.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  createTestDatabase,
  applyRuntimeUserColumns,
  applyArchiveSchema,
  seedUser
} = require('../utils/pgMemTestUtils');

let db, pool, queryFn, userId, mockChatspaceDir;

async function applyCosColumns(q) {
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_chief_of_staff BOOLEAN NOT NULL DEFAULT FALSE');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS spawn_depth INTEGER DEFAULT 0');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS initial_instructions TEXT');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS auto_spawned BOOLEAN DEFAULT FALSE');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMP');
  await q('ALTER TABLE agents ADD COLUMN IF NOT EXISTS position INTEGER');
}

beforeEach(async () => {
  jest.resetModules();

  const testDb = createTestDatabase();
  db = testDb.db;
  pool = testDb.pool;
  queryFn = testDb.query;

  await applyRuntimeUserColumns(queryFn);
  await applyArchiveSchema(queryFn);
  await applyCosColumns(queryFn);

  const seeded = await seedUser(queryFn);
  userId = seeded.userId;

  mockChatspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-test-'));
  process.env.CHATSPACE_DIR = mockChatspaceDir;

  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => queryFn(text, params),
    getClient: () => pool.connect(),
    pool
  }));

  jest.doMock('../../src/utils/logger', () => ({
    logInfo: jest.fn(),
    logWarn: jest.fn(),
    logError: jest.fn()
  }));
});

afterEach(async () => {
  delete process.env.CHATSPACE_DIR;
  try {
    fs.rmSync(mockChatspaceDir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
  await pool.end();
  jest.resetModules();
  jest.clearAllMocks();
});

function loadService() {
  return require('../../src/services/chiefOfStaffService');
}

describe('chiefOfStaffService', () => {

  describe('installChiefOfStaff', () => {

    it('inserts a CoS agent row with is_chief_of_staff = true and writes the chatspace folder', async () => {
      const service = loadService();

      const result = await service.installChiefOfStaff({
        userId,
        apiKey: 'test-key',
        encryptionSalt: 'test-salt',
        apiBase: 'http://localhost:3000/api',
        userPassword: 'pw',
        userName: 'restin'
      });

      expect(result.agent.isChiefOfStaff).toBe(true);
      expect(result.agent.agentName).toBe('Local Chief of Staff');
      expect(result.bootstrap.command).toMatch(/tmux new-session -d -s "local[_-]chief[_-]of[_-]staff"/);
      expect(result.agentDir).toBeTruthy();

      // DB row
      const dbRow = await queryFn(
        `SELECT agent_name, is_chief_of_staff, can_spawn, inter_agent_mode,
                initial_instructions, spawn_depth, agent_type
         FROM agents WHERE agent_id = $1`,
        [result.agent.agentId]
      );
      expect(dbRow.rows[0].is_chief_of_staff).toBe(true);
      expect(dbRow.rows[0].can_spawn).toBe(true);
      expect(dbRow.rows[0].inter_agent_mode).toBe('listen_all');
      expect(dbRow.rows[0].agent_type).toBe('standard');
      expect(dbRow.rows[0].spawn_depth).toBe(0);
      expect(dbRow.rows[0].initial_instructions).toContain('Chief of Staff');

      // Files on disk
      expect(fs.existsSync(path.join(result.agentDir, 'AGENT_INSTRUCTIONS.md'))).toBe(true);
      expect(fs.existsSync(path.join(result.agentDir, 'SKILL_AGENT_ROSTER.md'))).toBe(true);
      expect(fs.existsSync(path.join(result.agentDir, 'SKILL_TMUX_SPAWN.md'))).toBe(true);
      expect(fs.existsSync(path.join(result.agentDir, 'SKILL_RICH_FORMS.md'))).toBe(true);
      expect(fs.existsSync(path.join(result.agentDir, 'SELF_WAKE_GUIDE.md'))).toBe(true);
      expect(fs.existsSync(path.join(result.agentDir, 'agent-runner.sh'))).toBe(true);
      expect(fs.existsSync(path.join(result.agentDir, 'message_helper.py'))).toBe(true);
      expect(fs.existsSync(path.join(result.agentDir, '.env'))).toBe(true);
      expect(fs.existsSync(path.join(result.agentDir, 'agent_state', 'agent_config.json'))).toBe(true);
      expect(fs.existsSync(path.join(result.agentDir, 'agent_state', 'roster.json'))).toBe(true);
      expect(fs.existsSync(path.join(result.agentDir, 'agent_state', 'lineage.json'))).toBe(true);

      // .env contents
      const envText = fs.readFileSync(path.join(result.agentDir, '.env'), 'utf8');
      expect(envText).toContain('API_KEY="test-key"');
      expect(envText).toContain('ENCRYPTION_SALT="test-salt"');
      expect(envText).toContain('IS_CHIEF_OF_STAFF="true"');

      const config = JSON.parse(fs.readFileSync(
        path.join(result.agentDir, 'agent_state', 'agent_config.json'),
        'utf8'
      ));
      expect(config.approval_mode).toBe('full-auto');
      expect(config.sandbox_mode).toBe('workspace-write');

      const permissions = JSON.parse(fs.readFileSync(
        path.join(result.agentDir, 'agent_state', 'allowed_permissions.json'),
        'utf8'
      ));
      expect(Object.keys(permissions)).toEqual(expect.arrayContaining([
        'claude',
        'codex',
        'gemini',
        'copilot',
        'antigravity',
        'pi',
        'kilo',
        'ollama',
        'openrouter',
        'lmstudio'
      ]));
      // Safe-by-default ceiling: dangerous bypass flags require explicit opt-in.
      expect(permissions.antigravity['--dangerously-skip-permissions']).toBe(false);
      expect(permissions.copilot['--allow-all']).toBe(false);
      expect(permissions.gemini['--no-sandbox']).toBe(false);

      const runtimeRow = await queryFn(
        `SELECT allowed_permissions FROM agents WHERE agent_id = $1`,
        [result.agent.agentId]
      );
      expect(Object.keys(runtimeRow.rows[0].allowed_permissions)).toEqual(expect.arrayContaining([
        'claude',
        'codex',
        'gemini',
        'copilot',
        'antigravity',
        'pi',
        'kilo',
        'ollama',
        'openrouter',
        'lmstudio'
      ]));
    });

    it('does NOT bake the server-side project_path into the CoS runtime_config (DB or agent_config.json)', async () => {
      // Regression for: a CoS installed via the server was storing the SERVER's
      // own path (e.g. /home/ubuntu/projects/AgentsMCPspace) into project_path.
      // When the user pulled config on their own machine, agent-runner.sh did
      // `cd "$PROJECT_ROOT"` and crashed with "No such file or directory".
      const service = loadService();
      const result = await service.installChiefOfStaff({
        userId,
        apiKey: 'test-key',
        encryptionSalt: 'test-salt',
        userPassword: 'pw',
        userName: 'restin'
      });

      // 1) The on-disk agent_config.json must NOT contain project_path.
      const config = JSON.parse(fs.readFileSync(
        path.join(result.agentDir, 'agent_state', 'agent_config.json'),
        'utf8'
      ));
      expect(config.project_path).toBeUndefined();

      // 2) The runtime_config persisted in the DB must NOT contain project_path.
      const dbRow = await queryFn(
        `SELECT runtime_config FROM agents WHERE agent_id = $1`,
        [result.agent.agentId]
      );
      const runtimeConfig = dbRow.rows[0].runtime_config || {};
      expect(runtimeConfig.project_path).toBeUndefined();
    });

    it('strips sensitive entries from the returned fileBundle when skipFiles=false', async () => {
      const service = loadService();
      const result = await service.installChiefOfStaff({
        userId,
        apiKey: 'secret-key',
        encryptionSalt: 'secret-salt',
        userPassword: 'super-secret',
        agentName: 'Local Chief of Staff - strip-test'
      });

      // skipFiles defaulted to false, so the bundle echoed back over the wire
      // must NOT include the .env (sensitive: true) entry.
      expect(result.fileBundle['.env']).toBeUndefined();
      // Non-sensitive entries should still be present so callers can verify
      // what was written.
      expect(result.fileBundle['AGENT_INSTRUCTIONS.md']).toBeDefined();
      expect(result.fileBundle['agent-runner.sh']).toBeDefined();

      // The .env file should still exist on disk where the server wrote it.
      const envText = fs.readFileSync(path.join(result.agentDir, '.env'), 'utf8');
      expect(envText).toContain('API_KEY="secret-key"');
    });

    it('returns the full fileBundle (including .env) when skipFiles=true', async () => {
      const service = loadService();
      const result = await service.installChiefOfStaff({
        userId,
        apiKey: 'remote-key',
        encryptionSalt: 'remote-salt',
        userPassword: 'remote-pw',
        agentName: 'Local Chief of Staff - cli-install',
        skipFiles: true
      });

      // CLI install path needs the bundle to materialize on the client.
      expect(result.fileBundle['.env']).toBeDefined();
      expect(result.fileBundle['.env'].sensitive).toBe(true);
      expect(result.fileBundle['.env'].content).toContain('API_KEY="remote-key"');
      const permissions = JSON.parse(result.fileBundle['agent_state/allowed_permissions.json'].content);
      expect(Object.keys(permissions)).toEqual(expect.arrayContaining([
        'claude',
        'codex',
        'gemini',
        'copilot',
        'antigravity',
        'pi',
        'kilo',
        'ollama',
        'openrouter',
        'lmstudio'
      ]));
      // Server did not write files in this path.
      expect(result.agentDir).toBeNull();
    });

    it('allows multiple named CoS installs for the same user', async () => {
      const service = loadService();
      const first = await service.installChiefOfStaff({
        userId,
        apiKey: 'k',
        encryptionSalt: 's',
        agentName: 'Local Chief of Staff - laptop'
      });

      const second = await service.installChiefOfStaff({
        userId,
        apiKey: 'k',
        encryptionSalt: 's',
        agentName: 'Local Chief of Staff - desktop'
      });

      expect(first.agent.agentName).toBe('Local Chief of Staff - laptop');
      expect(second.agent.agentName).toBe('Local Chief of Staff - desktop');

      const chiefs = await service.listChiefsOfStaffForUser(userId);
      expect(chiefs).toHaveLength(2);
    });

    it('refuses a second install with the same CoS name for the same user', async () => {
      const service = loadService();
      await service.installChiefOfStaff({
        userId,
        apiKey: 'k',
        encryptionSalt: 's',
        agentName: 'Local Chief of Staff - laptop'
      });

      await expect(
        service.installChiefOfStaff({
          userId,
          apiKey: 'k',
          encryptionSalt: 's',
          agentName: 'Local Chief of Staff - laptop'
        })
      ).rejects.toMatchObject({ code: 'COS_ALREADY_INSTALLED' });
    });

    it('refuses if a non-CoS agent with the canonical name already exists', async () => {
      // Insert a normal agent named "Local Chief of Staff" first.
      await queryFn(
        `INSERT INTO agents (user_id, agent_name, agent_type, position, is_chief_of_staff)
         VALUES ($1, 'Local Chief of Staff', 'standard', 1, FALSE)`,
        [userId]
      );

      const service = loadService();
      await expect(
        service.installChiefOfStaff({ userId, apiKey: 'k', encryptionSalt: 's' })
      ).rejects.toMatchObject({ code: 'COS_NAME_CONFLICT' });
    });

    it('requires apiKey', async () => {
      const service = loadService();
      await expect(
        service.installChiefOfStaff({ userId })
      ).rejects.toMatchObject({ code: 'COS_INVALID_INPUT' });
    });
  });

  describe('getChiefOfStaffForUser / isChiefOfStaff', () => {
    it('returns null/false until install, then the row/true after install', async () => {
      const service = loadService();
      expect(await service.getChiefOfStaffForUser(userId)).toBeNull();

      const { agent } = await service.installChiefOfStaff({
        userId, apiKey: 'k', encryptionSalt: 's'
      });

      const row = await service.getChiefOfStaffForUser(userId);
      expect(row).not.toBeNull();
      expect(row.agent_id).toBe(agent.agentId);
      expect(await service.isChiefOfStaff(agent.agentId)).toBe(true);
    });

    it('isChiefOfStaff returns false for a non-CoS agent', async () => {
      const result = await queryFn(
        `INSERT INTO agents (user_id, agent_name, agent_type, position, is_chief_of_staff)
         VALUES ($1, 'helper', 'standard', 1, FALSE)
         RETURNING agent_id`,
        [userId]
      );
      const service = loadService();
      expect(await service.isChiefOfStaff(result.rows[0].agent_id)).toBe(false);
    });
  });

  describe('listRoster', () => {
    it('returns every agent owned by the user, CoS first', async () => {
      const service = loadService();
      // Plain agent
      await queryFn(
        `INSERT INTO agents (user_id, agent_name, agent_type, position, is_chief_of_staff)
         VALUES ($1, 'helper-1', 'standard', 1, FALSE)`,
        [userId]
      );
      await service.installChiefOfStaff({ userId, apiKey: 'k', encryptionSalt: 's' });

      const roster = await service.listRoster(userId);
      expect(roster.length).toBe(2);
      expect(roster[0].is_chief_of_staff).toBe(true);
      expect(roster[0].agent_name).toBe('Local Chief of Staff');
      expect(roster[1].agent_name).toBe('helper-1');
    });
  });

  describe('writeChildAgentFiles', () => {
    it('creates the chatspace folder with runner + helper + instructions', () => {
      const service = loadService();
      const out = service.writeChildAgentFiles({
        agentName: 'research-agent',
        agentId: '11111111-1111-1111-1111-111111111111',
        initialInstructions: 'Scrape and summarize',
        credentials: {
          apiKey: 'k',
          encryptionSalt: 's',
          apiBase: 'http://localhost:3000/api',
          userPassword: 'pw'
        }
      });
      expect(out).toMatch(/research-agent$/);
      expect(fs.existsSync(path.join(out, 'AGENT_INSTRUCTIONS.md'))).toBe(true);
      expect(fs.existsSync(path.join(out, 'agent-runner.sh'))).toBe(true);
      expect(fs.existsSync(path.join(out, 'message_helper.py'))).toBe(true);
      expect(fs.existsSync(path.join(out, '.env'))).toBe(true);
      const instr = fs.readFileSync(path.join(out, 'AGENT_INSTRUCTIONS.md'), 'utf8');
      expect(instr).toContain('research-agent');
      expect(instr).toContain('Scrape and summarize');

      const config = JSON.parse(fs.readFileSync(
        path.join(out, 'agent_state', 'agent_config.json'),
        'utf8'
      ));
      expect(config.approval_mode).toBe('full-auto');
      expect(config.sandbox_mode).toBe('workspace-write');
      // Default CoS children work inside their own local folder, not the
      // server's project directory.
      expect(config.project_path).toBe(out);
      expect(fs.existsSync(path.join(out, 'memory', 'MEMORY.md'))).toBe(true);

      const permissions = JSON.parse(fs.readFileSync(
        path.join(out, 'agent_state', 'allowed_permissions.json'),
        'utf8'
      ));
      expect(Object.keys(permissions)).toEqual(expect.arrayContaining([
        'claude',
        'codex',
        'gemini',
        'copilot',
        'antigravity',
        'pi',
        'kilo',
        'ollama',
        'openrouter',
        'lmstudio'
      ]));
      expect(permissions.antigravity['--sandbox']).toContain('workspace-write');
      expect(permissions.antigravity['--sandbox']).not.toContain('danger-full-access');
    });

    it('preserves the child runtime config and permissions supplied by spawnAgent', () => {
      const service = loadService();
      const out = service.writeChildAgentFiles({
        agentName: 'codex-worker',
        agentId: '22222222-2222-2222-2222-222222222222',
        initialInstructions: 'Run local commands',
        runtimeConfig: {
          model_provider: 'codex',
          model: 'gpt-5.4',
          approval_mode: 'full-auto',
          sandbox_mode: 'none',
          project_path: '/tmp/project'
        },
        allowedPermissions: {
          inter_agent: { enabled: true, mode: 'listen_all', groups: [] },
          codex: {
            '--sandbox': ['workspace-write', 'danger-full-access'],
            '--dangerously-bypass-approvals-and-sandbox': true
          }
        },
        credentials: {
          apiKey: 'k',
          encryptionSalt: 's',
          apiBase: 'http://localhost:3000/api',
          userPassword: 'pw'
        }
      });

      const config = JSON.parse(fs.readFileSync(
        path.join(out, 'agent_state', 'agent_config.json'),
        'utf8'
      ));
      expect(config.model_provider).toBe('codex');
      expect(config.approval_mode).toBe('full-auto');
      expect(config.sandbox_mode).toBe('none');
      expect(config.project_path).toBe('/tmp/project');

      const permissions = JSON.parse(fs.readFileSync(
        path.join(out, 'agent_state', 'allowed_permissions.json'),
        'utf8'
      ));
      expect(permissions.codex['--dangerously-bypass-approvals-and-sandbox']).toBe(true);
    });
  });
});
