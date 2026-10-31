const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const { createTestDatabase, applyRuntimeUserColumns, seedUser, applyArchiveSchema, applyLineageSchema } = require('../utils/pgMemTestUtils');

async function createAgentApiTestContext({ scopedAgentId = null, scopedContext = null, storage = null, encryptionSalt = null } = {}) {
  jest.resetModules();

  const { db, pool, query } = createTestDatabase();
  db.public.registerFunction({ name: 'current_schema', returns: 'text', implementation: () => 'public' });
  db.public.registerFunction({ name: 'date_trunc', args: ['text', 'timestamp'], returns: 'timestamp',
    implementation: (unit, value) => {
      if (unit !== 'milliseconds') throw new Error('Unexpected timestamp unit in history fixture');
      return new Date(value);
    } });
  await applyRuntimeUserColumns(query);
  await applyArchiveSchema(query);
  const { userId } = await seedUser(query);

  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => query(text, params),
    getClient: async () => {
      const client = await pool.connect();
      const original = client.query.bind(client);
      // pg-mem does not parse partial-index predicates in ON CONFLICT. Its
      // fixture index already provides the equivalent uniqueness check.
      client.query = (sql, args) => original(sql.replace(/ON CONFLICT \(agent_id, client_message_id\) WHERE client_message_id IS NOT NULL/g,
        'ON CONFLICT (agent_id, client_message_id)'), args);
      return client;
    },
    pool,
  }));

  jest.doMock('../../src/utils/securityLogger', () => ({
    logApiKeyUsage: jest.fn(),
    logRateLimitViolation: jest.fn(),
  }));

  jest.doMock('../../src/middleware/authMiddleware', () => ({
    requireApiKey: (req, _res, next) => {
      req.user = { userId, encryptionSalt };
      req.authContext = scopedContext || (scopedAgentId ? { type: 'agent_token', agentId: scopedAgentId } : { type: 'api_key' });
      next();
    },
  }));

      jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
        agentPollingRateLimiter: (_req, _res, next) => next(),
        agentApiRateLimiter: (_req, _res, next) => next(),
        agentMessageIngressRateLimiter: (_req, _res, next) => next(),
        feedbackRateLimiter: (_req, _res, next) => next(),
      }));

  if (storage) jest.doMock('../../src/storage', () => ({ initializeStorage: async () => storage }));
  else jest.dontMock('../../src/storage');
  const agentApiRoutes = require('../../src/routes/agentApiRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentApiRoutes);

  return { app, query, pool, userId };
}

describe('Agent API routes', () => {
  it('returns bounded encrypted samples, scoped to the agent for agent tokens', async () => {
    const own = uuidv4(), other = uuidv4();
    const f = await createAgentApiTestContext({ scopedAgentId: own });
    try {
      await applyLineageSchema(f.query);
      await f.query('INSERT INTO agents(agent_id,user_id,agent_name,position) VALUES($1,$2,$3,1),($4,$2,$5,2)', [own, f.userId, 'Own', other, 'Other']);
      await f.query(`INSERT INTO user_messages(user_message_id,agent_id,content,encrypted) VALUES
        ($1,$2,'own-cipher',TRUE),($3,$2,'own-plain',FALSE),($4,$5,'other-cipher',TRUE)`, [uuidv4(), own, uuidv4(), uuidv4(), other]);
      const scoped = await request(f.app).get('/api/agent/encryption-samples').expect(200);
      expect(scoped.headers['cache-control']).toBe('no-store');
      expect(scoped.body.samples).toEqual(['own-cipher']);
    } finally { await f.pool.end(); }
    const account = await createAgentApiTestContext();
    try {
      await applyLineageSchema(account.query);
      await account.query('INSERT INTO agents(agent_id,user_id,agent_name,position) VALUES($1,$2,$3,1),($4,$2,$5,2)', [own, account.userId, 'Own', other, 'Other']);
      await account.query(`INSERT INTO user_messages(user_message_id,agent_id,content,encrypted) VALUES
        ($1,$2,'own-cipher',TRUE),($3,$4,'other-cipher',TRUE)`, [uuidv4(), own, uuidv4(), other]);
      const response = await request(account.app).get('/api/agent/encryption-samples').expect(200);
      expect(response.body.samples.sort()).toEqual(['other-cipher', 'own-cipher']);
    } finally { await account.pool.end(); }
  });

  it('accepts the runner plain-text decryption warning under a private execution lease', async () => {
    const agentId = uuidv4();
    const previous = process.env.FEATURE_IN_PLACE_AGENT_SHARING;
    process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
    const f = await createAgentApiTestContext({ scopedContext: { type: 'agent_token', agentId, agentName: 'Locked Out' } });
    try {
      const fs = require('fs'), path = require('path');
      for (const migration of ['041_add_message_idempotency.sql', '042_add_shared_conversations.sql', '054_add_agent_chat_threads.sql', '064_add_sharing_switch.sql']) {
        await f.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', migration), 'utf8'));
      }
      await f.query('INSERT INTO agents(agent_id,user_id,agent_name,position) VALUES($1,$2,$3,1)', [agentId, f.userId, 'Locked Out']);
      const runtimeId = uuidv4(), executionId = uuidv4();
      await f.query("INSERT INTO shared_runtimes(agent_id,runtime_id,capabilities,execution_id,execution_kind,execution_uncertain) VALUES($1,$2,'{}',$3,'private',FALSE)", [agentId, runtimeId, executionId]);
      await request(f.app).post('/api/agent/messages')
        .set('x-shared-runtime', runtimeId).set('x-shared-private-execution', executionId)
        .send({ agentName: 'Locked Out', encrypted: false, priority: 2, clientMessageId: uuidv4(), content: 'Locked Out is running but cannot read your message.' })
        .expect(201);
      const rows = (await f.query('SELECT content, encrypted FROM messages WHERE agent_id=$1', [agentId])).rows;
      expect(rows).toEqual([{ content: 'Locked Out is running but cannot read your message.', encrypted: false }]);
    } finally {
      if (previous === undefined) delete process.env.FEATURE_IN_PLACE_AGENT_SHARING; else process.env.FEATURE_IN_PLACE_AGENT_SHARING = previous;
      await f.pool.end();
    }
  });

  it('returns the authenticated owner derivation salt for native recovery without re-enrollment', async () => {
    const agentId = uuidv4(), encryptionSalt = Buffer.alloc(32, 3).toString('base64');
    const f = await createAgentApiTestContext({ scopedAgentId: agentId, encryptionSalt });
    try {
      await applyLineageSchema(f.query);
      await f.query('INSERT INTO agents(agent_id,user_id,agent_name,position) VALUES($1,$2,$3,1)', [agentId, f.userId, 'EncryptionFixture']);
      const response = await request(f.app).get('/api/agent/config?agentName=EncryptionFixture').expect(200);
      expect(response.body).toMatchObject({ agentId, encryptionSalt });
      expect(response.body.token).toBeUndefined();
      expect(response.body.apiKey).toBeUndefined();
      expect(response.body.password).toBeUndefined();
      await request(f.app).get('/api/agent/config?agentName=MissingFixture').expect(404);
      expect((await f.query('SELECT * FROM agent_api_credentials WHERE agent_id=$1', [agentId])).rows).toHaveLength(0);
    } finally { await f.pool.end(); }
  });
  it('enrolls an owned native runtime without shared conversations or broad account access', async () => {
    const f = await createAgentApiTestContext();
    const previous = process.env.FEATURE_SHARED_CONVERSATIONS;
    process.env.FEATURE_SHARED_CONVERSATIONS = 'false';
    try {
      const agentId = uuidv4();
      await f.query('INSERT INTO agents(agent_id,user_id,agent_name,position) VALUES($1,$2,$3,1)', [agentId, f.userId, 'Native Fixture']);
      const response = await request(f.app).post('/api/agent/runtime-enroll').send({ agentName: 'Native Fixture', scopes: ['*'] }).expect(201);
      expect(response.body.agentId).toBe(agentId);
      expect(response.body.token).toMatch(/^agt_/);
      expect(response.headers['cache-control']).toBe('no-store');
      const credentials = (await f.query('SELECT token_hash, scopes_json FROM agent_api_credentials WHERE agent_id=$1', [agentId])).rows;
      expect(credentials).toHaveLength(1);
      expect(credentials[0].token_hash).not.toBe(response.body.token);
      expect(credentials[0].scopes_json).toContain('agent.responses.read');
      expect(credentials[0].scopes_json).not.toContain('*');
      await request(f.app).post('/api/agent/runtime-enroll').send({ agentName: 'Unowned Agent' }).expect(404);
      await request(f.app).post('/api/agent/runtime-enroll').send({}).expect(400);
    } finally {
      if (previous === undefined) delete process.env.FEATURE_SHARED_CONVERSATIONS; else process.env.FEATURE_SHARED_CONVERSATIONS = previous;
      await f.pool.end();
    }
  });

  it('does not let a scoped runtime mint another credential', async () => {
    const f = await createAgentApiTestContext({ scopedAgentId: 'scoped-fixture' });
    try { await request(f.app).post('/api/agent/runtime-enroll').send({ agentName: 'Native Fixture' }).expect(403); }
    finally { await f.pool.end(); }
  });

  it('filters hidden and archived answers and pages same-timestamp history without skips', async () => {
    const f = await createAgentApiTestContext();
    try {
      await f.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS hidden_from_agent BOOLEAN DEFAULT FALSE');
      await f.query('ALTER TABLE user_messages ADD COLUMN IF NOT EXISTS hidden_from_agent BOOLEAN DEFAULT FALSE');
      const agentId = uuidv4();
      const ids = [1, 2, 3, 4, 5].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
      const at = new Date('2026-01-02T03:04:05.000Z');
      await f.query('INSERT INTO agents(agent_id,user_id,agent_name,position) VALUES($1,$2,$3,1)', [agentId, f.userId, 'History Cursor']);
      await f.query("INSERT INTO messages(message_id,agent_id,message_type,content,created_at) VALUES($1,$2,'message','first',$3),($4,$2,'message','second',$3)", [ids[0], agentId, at, ids[1]]);
      await f.query('INSERT INTO user_messages(user_message_id,agent_id,content,created_at) VALUES($1,$2,$3,$4)', [ids[2], agentId, 'third', at]);
      await f.query("INSERT INTO messages(message_id,agent_id,message_type,content,hidden_from_agent,created_at) VALUES($1,$2,'question','hidden',TRUE,$3),($4,$2,'question','archived',FALSE,$3)", [ids[3], agentId, at, ids[4]]);
      await f.query('INSERT INTO user_responses(response_id,message_id,free_response,created_at) VALUES($1,$2,$3,$4),($5,$6,$7,$4)', [uuidv4(), ids[3], 'hidden answer', at, uuidv4(), ids[4], 'archived answer']);
      await f.query("INSERT INTO archived_messages(message_id,agent_id,user_id,message_type) VALUES($1,$2,$3,'question')", [ids[4], agentId, f.userId]);

      const firstPage = await request(f.app).get('/api/agent/messages/history')
        .query({ agentName: 'History Cursor', limit: 2 }).expect(200);
      expect(firstPage.body.messages.map(item => item.messageId)).toEqual([ids[1], ids[2]]);
      const secondPage = await request(f.app).get('/api/agent/messages/history')
        .query({ agentName: 'History Cursor', limit: 2, beforeId: ids[1] }).expect(200);
      expect(secondPage.body.messages.map(item => item.messageId)).toEqual([ids[0]]);
      const all = [...firstPage.body.messages, ...secondPage.body.messages];
      expect(all.map(item => item.messageId)).toEqual([ids[1], ids[2], ids[0]]);
      expect(JSON.stringify(all)).not.toContain('hidden answer');
      expect(JSON.stringify(all)).not.toContain('archived answer');
      for (const invisibleId of [ids[3], ids[4], uuidv4()]) {
        await request(f.app).get('/api/agent/messages/history')
          .query({ agentName: 'History Cursor', limit: 2, beforeId: invisibleId }).expect(400);
      }
    } finally { await f.pool.end(); }
  });

  it('delivers encrypted peer attachments and rechecks recipient permissions on each download', async () => {
    const senderId = uuidv4(), recipientId = uuidv4(), attachmentId = uuidv4(), messageId = uuidv4();
    const actor = { type: 'agent_token', agentId: senderId, agentName: 'File Sender', scopes: ['agent.dm.read', 'agent.attachments.read'] };
    const encrypted = Buffer.from('encrypted-file-bytes');
    const f = await createAgentApiTestContext({ scopedContext: actor, storage: { name: 'fixture', retrieve: async () => encrypted } });
    try {
      await f.query("INSERT INTO agents(agent_id,user_id,agent_name,position,inter_agent_mode) VALUES($1,$2,'File Sender',1,'listen_all'),($3,$2,'File Recipient',2,'listen_all')", [senderId, f.userId, recipientId]);
      await f.query("INSERT INTO attachments(attachment_id,agent_id,content_type,file_name,size_bytes,storage_key,encrypted,iv_base64,auth_tag_base64,uploaded_by) VALUES($1,$2,'application/pdf','peer.pdf',$3,'fixture-key',TRUE,$4,$5,'agent')", [attachmentId, senderId, encrypted.length, Buffer.alloc(12).toString('base64'), Buffer.alloc(16).toString('base64')]);
      const payload = { toAgentName: 'File Recipient', content: 'encrypted-peer-message', encrypted: true, clientMessageId: messageId, attachmentIds: [attachmentId] };
      await request(f.app).post('/api/agent/messages/direct').set('X-Agent-Name', 'File Sender').send(payload).expect(201);
      await request(f.app).post('/api/agent/messages/direct').set('X-Agent-Name', 'File Sender').send(payload).expect(200);
      await request(f.app).post('/api/agent/messages/direct').set('X-Agent-Name', 'File Sender').send({ ...payload, attachmentIds: [] }).expect(409);
      expect((await f.query('SELECT attachment_id FROM agent_message_attachments WHERE agent_message_id=$1', [messageId])).rows).toHaveLength(1);
      actor.agentId = recipientId; actor.agentName = 'File Recipient';
      const inbox = await request(f.app).get('/api/agent/messages/direct').set('X-Agent-Name', 'File Recipient').query({ markRead: false }).expect(200);
      expect(inbox.body.messages[0].attachments[0]).toMatchObject({ attachmentId, contentType: 'application/pdf' });
      const metadata = await request(f.app).get(`/api/agent/attachments/${attachmentId}/metadata`).expect(200);
      expect(metadata.body.peerAgentId).toBe(senderId);
      const file = await request(f.app).get(`/api/agent/attachments/${attachmentId}`).expect(200);
      expect(file.body).toEqual(encrypted);
      actor.scopes = ['agent.attachments.read'];
      await request(f.app).get(`/api/agent/attachments/${attachmentId}/metadata`).expect(404);
      actor.scopes.push('agent.dm.read');
      await f.query("UPDATE agents SET inter_agent_mode='disabled' WHERE agent_id=$1", [senderId]);
      await request(f.app).get(`/api/agent/attachments/${attachmentId}/metadata`).expect(404);
      await request(f.app).get(`/api/agent/attachments/${attachmentId}`).expect(404);
    } finally { await f.pool.end(); }
  });

  it('stores agent bug reports and feature requests as anonymous feedback', async () => {
    const f = await createAgentApiTestContext();
    try {
      const res = await request(f.app).post('/api/agent/feedback')
        .send({ type: 'bug', message: '  Send button misaligned  ', pageUrl: 'https://chatmcp.space/dashboard' }).expect(201);
      expect(res.body.success).toBe(true);
      const rows = (await f.query('SELECT message, kind, page_url FROM feedback')).rows;
      expect(rows).toEqual([{ message: '[Bug report via agent] Send button misaligned', kind: 'feedback', page_url: 'https://chatmcp.space/dashboard' }]);
      await request(f.app).post('/api/agent/feedback').send({ type: 'spam', message: 'x' }).expect(400);
      await request(f.app).post('/api/agent/feedback').send({ type: 'feature', message: '   ' }).expect(400);
    } finally { await f.pool.end(); }
  });
  it('persists owner CLI grants so dashboard config loads cannot restore stale permission limits', async () => {
    const f = await createAgentApiTestContext(); const agentId = uuidv4();
    try {
      await applyLineageSchema(f.query);
      await f.query('INSERT INTO agents(agent_id,user_id,agent_name,position) VALUES($1,$2,$3,1)', [agentId, f.userId, 'PermissionFixture']);
      const allowedPermissions = { codex: { '--sandbox': ['danger-full-access'], '--dangerously-bypass-approvals-and-sandbox': true } };
      await request(f.app).post('/api/agent/runtime-permissions').send({ agentName: 'PermissionFixture', allowedPermissions,
        config: { model_provider: 'codex', model: 'default', approval_mode: 'full-auto', sandbox_mode: 'none', project_path: '/project' } }).expect(200);
      const loaded = await request(f.app).get('/api/agent/config?agentName=PermissionFixture').expect(200);
      expect(loaded.body).toMatchObject({ allowedPermissions, config: { sandbox_mode: 'none', approval_mode: 'full-auto', project_path: '/project' } });
    } finally { await f.pool.end(); }
  });
  it('registers a new CLI agent before its first message and safely retries the grant', async () => {
    const f = await createAgentApiTestContext();
    try {
      await applyLineageSchema(f.query);
      const body = { agentName: 'Fresh CLI Agent',
        allowedPermissions: { codex: { '--sandbox': ['danger-full-access'] }, inter_agent: { enabled: true, mode: 'listen_all' } },
        config: { model_provider: 'codex', model: 'default', approval_mode: 'full-auto', sandbox_mode: 'none', project_path: '/tmp/my project' } };
      await request(f.app).post('/api/agent/runtime-permissions').send(body).expect(200);
      const first = (await f.query('SELECT * FROM agents WHERE user_id=$1 AND agent_name=$2', [f.userId, body.agentName])).rows[0];
      expect(first).toMatchObject({ can_spawn: true, inter_agent_mode: 'listen_all', runtime_config: body.config, allowed_permissions: body.allowedPermissions });
      await request(f.app).post('/api/agent/runtime-permissions').send(body).expect(200);
      const rows = (await f.query('SELECT agent_id FROM agents WHERE user_id=$1 AND agent_name=$2', [f.userId, body.agentName])).rows;
      expect(rows).toEqual([{ agent_id: first.agent_id }]);
      expect((await f.query('SELECT message_id FROM messages WHERE agent_id=$1', [first.agent_id])).rows).toEqual([]);
      const loaded = await request(f.app).get('/api/agent/config').query({ agentName: body.agentName }).expect(200);
      expect(loaded.body).toMatchObject({ config: body.config, allowedPermissions: body.allowedPermissions, interAgentMode: 'listen_all' });
    } finally { await f.pool.end(); }
  });

  it.each(['interactive', 'headless-safe', 'headless-max'])('completes generated %s setup against the API before any runner starts', async mode => {
    const f = await createAgentApiTestContext();
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-registration-'));
    const server = f.app.listen(0, '127.0.0.1');
    try {
      await new Promise(resolve => server.once('listening', resolve));
      const { generateMainCLIScript } = require('../../src/utils/apiGuideGenerator');
      const generated = generateMainCLIScript('fixture-key', `http://127.0.0.1:${server.address().port}`);
      // Use the real CLI functions and real curl. Replace only startup dependency
      // installation/model discovery and terminal input; never start a provider.
      const entry = generated.lastIndexOf('print_bootstrap_info "Initializing agent CLI..."');
      expect(entry).toBeGreaterThan(0);
      const harness = generated.slice(0, entry) + `
        gum() {
          case "$1" in
            input) case "$*" in *"Agent Name:"*) printf '%s' 'CLI Fixture';; *) printf '%s' "$PWD";; esac ;;
            choose) case "$*" in *"Permissions for this agent"*) printf max-access;; *) printf Cancel;; esac ;;
            confirm) return 1 ;;
          esac
        }
        ${mode === 'interactive' ? 'create_agent' : 'create_agent_headless "CLI Fixture"'}
      `;
      const cli = path.join(dir, 'agent-cli.sh');
      fs.writeFileSync(cli, harness);
      const run = args => new Promise((resolve, reject) => {
        require('child_process').execFile('bash', [cli, ...args], { cwd: dir, timeout: 15000 }, (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`)); else resolve(stdout);
        });
      });
      const args = mode === 'interactive' ? [] : ['--headless', '--no-auto-start', mode === 'headless-safe' ? '--safe-defaults' : '--allow-all'];
      await run(args);
      const folder = path.join(dir, '.chatspace', 'cli_fixture', 'agent_state');
      const config = JSON.parse(fs.readFileSync(path.join(folder, 'agent_config.json')));
      const allowedPermissions = JSON.parse(fs.readFileSync(path.join(folder, 'allowed_permissions.json')));
      const row = (await f.query('SELECT * FROM agents WHERE user_id=$1', [f.userId])).rows[0];
      const { provider, started_at, ...savedConfig } = config;
      expect(row).toMatchObject({ agent_name: 'CLI Fixture', runtime_config: savedConfig, allowed_permissions: allowedPermissions });
      expect(row.runtime_config.project_path).toBe(dir);
      expect(row.runtime_config.sandbox_mode).toBe(mode === 'headless-safe' ? 'workspace-write' : 'none');
      // Resume the files left by an interrupted setup, preserving their config.
      fs.writeFileSync(cli, generated.slice(0, entry) + '\nrun_agent_headless "CLI Fixture" preserve\n');
      await run(['--headless', '--no-auto-start']);
      expect((await f.query('SELECT agent_id FROM agents WHERE user_id=$1', [f.userId])).rows).toEqual([{ agent_id: row.agent_id }]);
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
      await f.pool.end();
    }
  }, 30000);

  it('keeps same-named agents and their settings isolated between owners', async () => {
    const f = await createAgentApiTestContext();
    try {
      const other = await seedUser(f.query, { email: 'other-owner@example.com' });
      const otherId = uuidv4();
      await f.query('INSERT INTO agents(agent_id,user_id,agent_name,position) VALUES($1,$2,$3,1)', [otherId, other.userId, 'Same Name']);
      await request(f.app).post('/api/agent/runtime-permissions').send({ agentName: 'Same Name',
        allowedPermissions: { codex: {}, inter_agent: { enabled: true, mode: 'listen_all' } }, config: { model_provider: 'codex' } }).expect(200);
      const rows = (await f.query('SELECT agent_id,user_id,inter_agent_mode FROM agents WHERE agent_name=$1', ['Same Name'])).rows;
      expect(rows).toHaveLength(2);
      expect(rows.find(row => row.user_id === other.userId)).toMatchObject({ agent_id: otherId, inter_agent_mode: 'disabled' });
      expect(rows.find(row => row.user_id === f.userId)).toMatchObject({ inter_agent_mode: 'listen_all' });
    } finally { await f.pool.end(); }
  });

  it.each([
    { allowedPermissions: { unknownProvider: {} } },
    { allowedPermissions: { codex: {}, inter_agent: { enabled: true, mode: 'invalid' } } },
    { allowedPermissions: { codex: {} }, config: { model_provider: 'claude' } },
  ])('rejects invalid setup before creating an agent: %j', async body => {
    const f = await createAgentApiTestContext();
    try {
      await request(f.app).post('/api/agent/runtime-permissions').send({ agentName: 'Invalid Setup', ...body }).expect(400);
      expect((await f.query('SELECT agent_id FROM agents WHERE user_id=$1', [f.userId])).rows).toEqual([]);
    } finally { await f.pool.end(); }
  });

  it('synchronizes group membership on retries and removes it when communication is disabled', async () => {
    const f = await createAgentApiTestContext();
    try {
      const body = { agentName: 'Group CLI Agent', allowedPermissions: { codex: {},
        inter_agent: { enabled: true, mode: 'groups', groups: ['Team One', 'Team One'] } }, config: { model_provider: 'codex' } };
      await request(f.app).post('/api/agent/runtime-permissions').send(body).expect(200);
      await request(f.app).post('/api/agent/runtime-permissions').send(body).expect(200);
      expect((await f.query('SELECT * FROM agent_group_members')).rows).toHaveLength(1);
      body.allowedPermissions.inter_agent = { enabled: false };
      await request(f.app).post('/api/agent/runtime-permissions').send(body).expect(200);
      expect((await f.query('SELECT * FROM agent_group_members')).rows).toHaveLength(0);
      expect((await f.query('SELECT inter_agent_mode FROM agents WHERE user_id=$1', [f.userId])).rows[0].inter_agent_mode).toBe('disabled');
    } finally { await f.pool.end(); }
  });

  it('rejects attempts by scoped runtime credentials to grant themselves full access', async () => {
    const f = await createAgentApiTestContext({ scopedAgentId: uuidv4() });
    try { await request(f.app).post('/api/agent/runtime-permissions').send({ agentName: 'Alpha', allowedPermissions: { codex: {} } }).expect(403); }
    finally { await f.pool.end(); }
  });
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  async function sharedPrivateReplyFixture(scoped = true) {
    const agentId = uuidv4(), runtimeId = uuidv4(), executionId = uuidv4(), roomId = uuidv4();
    const fixture = await createAgentApiTestContext({ scopedAgentId: scoped ? agentId : null });
    const fs = require('fs'), path = require('path');
    await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/041_add_message_idempotency.sql'), 'utf8'));
    await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/042_add_shared_conversations.sql'), 'utf8'));
    await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/064_add_sharing_switch.sql'), 'utf8'));
    await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/054_add_agent_chat_threads.sql'), 'utf8'));
    await fixture.query('INSERT INTO agents(agent_id,user_id,agent_name,position) VALUES($1,$2,$3,1)', [agentId, fixture.userId, 'Alpha']);
    await fixture.query("INSERT INTO shared_conversations(id,agent_id,owner_id,title) VALUES($1,$2,$3,'Shared Alpha')", [roomId, agentId, fixture.userId]);
    await fixture.query("INSERT INTO agent_chat_threads(conversation_id,agent_id,owner_id,is_primary,state) VALUES($1,$2,$3,TRUE,'preparing')", [roomId, agentId, fixture.userId]);
    await fixture.query("INSERT INTO shared_runtimes(agent_id,runtime_id,capabilities,execution_id,execution_kind,execution_uncertain) VALUES($1,$2,'{}',$3,'private',FALSE)", [agentId, runtimeId, executionId]);
    return { ...fixture, agentId, runtimeId, executionId, roomId };
  }
  async function withSharedFlags(callback) {
    const flags = ['FEATURE_IN_PLACE_AGENT_SHARING', 'FEATURE_SHARED_CONVERSATIONS'];
    const original = flags.map(flag => process.env[flag]);
    flags.forEach(flag => { process.env[flag] = 'true'; });
    try { await callback(); }
    finally { flags.forEach((flag, i) => { if (original[i] === undefined) delete process.env[flag]; else process.env[flag] = original[i]; }); }
  }

  it('delivers a completed private reply after sharing without rerunning it or exposing it to guests', async () => withSharedFlags(async () => {
    const f = await sharedPrivateReplyFixture();
    try {
      const body = { agentName: 'Alpha', content: 'fixture-iv:fixture-tag:fixture-ciphertext', encrypted: true, clientMessageId: uuidv4() };
      const send = () => request(f.app).post('/api/agent/messages').set('x-shared-runtime', f.runtimeId).set('x-shared-private-execution', f.executionId).send(body);
      const first = await send().expect(201);
      const replay = await send().expect(200);
      expect(replay.body).toMatchObject({ messageId: first.body.messageId, idempotent: true });
      expect((await f.query('SELECT content,encrypted FROM messages WHERE agent_id=$1', [f.agentId])).rows).toEqual([{ content: body.content, encrypted: true }]);
      expect((await f.query('SELECT id FROM shared_messages WHERE conversation_id=$1', [f.roomId])).rows).toEqual([]);
    } finally { await f.pool.end(); }
  }));

  it.each(['unscoped', 'plaintext', 'no-id', 'no-lease', 'wrong-runtime', 'wrong-execution', 'shared-execution', 'uncertain', 'expired'])
    ('rejects %s private replies into converted chats', async condition => withSharedFlags(async () => {
      const f = await sharedPrivateReplyFixture(condition !== 'unscoped');
      try {
        if (condition === 'shared-execution') await f.query("UPDATE shared_runtimes SET execution_kind='shared' WHERE agent_id=$1", [f.agentId]);
        if (condition === 'uncertain') await f.query('UPDATE shared_runtimes SET execution_uncertain=TRUE WHERE agent_id=$1', [f.agentId]);
        if (condition === 'expired') await f.query('UPDATE shared_runtimes SET last_seen_at=$2 WHERE agent_id=$1', [f.agentId, new Date(Date.now() - 300000)]);
        let req = request(f.app).post('/api/agent/messages').set('x-shared-runtime', condition === 'wrong-runtime' ? uuidv4() : f.runtimeId);
        if (condition !== 'no-lease') req = req.set('x-shared-private-execution', condition === 'wrong-execution' ? uuidv4() : f.executionId);
        await req.send({ agentName: 'Alpha', content: 'fixture ciphertext', encrypted: condition !== 'plaintext',
          ...(condition !== 'no-id' ? { clientMessageId: uuidv4() } : {}) }).expect(409);
        expect((await f.query('SELECT message_id FROM messages WHERE agent_id=$1', [f.agentId])).rows).toEqual([]);
      } finally { await f.pool.end(); }
    }));

  it('GET /api/agent/sharing-status reports active flags without exposing account configuration', async () => {
    const previous = [process.env.FEATURE_SHARED_CONVERSATIONS, process.env.FEATURE_GUEST_SHARING];
    const { app, pool } = await createAgentApiTestContext();
    try {
      process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
      process.env.FEATURE_GUEST_SHARING = 'true';
      const enabled = await request(app).get('/api/agent/sharing-status').expect(200);
      expect(enabled.body).toEqual({ enabled: true, guestEnabled: true, executionMode: 'trusted' });
      expect(enabled.headers['cache-control']).toBe('no-store');
      process.env.FEATURE_SHARED_CONVERSATIONS = 'false';
      const disabled = await request(app).get('/api/agent/sharing-status').expect(200);
      expect(disabled.body).toEqual({ enabled: false, guestEnabled: false, executionMode: 'trusted' });
    } finally {
      for (const [i, key] of ['FEATURE_SHARED_CONVERSATIONS', 'FEATURE_GUEST_SHARING'].entries()) {
        if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
      }
      await pool.end();
    }
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

  it('POST /api/agent/messages accepts the clientMessageId sent by new-agent introductions (regression)', async () => {
    const { app, pool } = await createAgentApiTestContext();
    const clientMessageId = uuidv4();

    const res = await request(app)
      .post('/api/agent/messages')
      .send({
        agentName: 'NewAgentIntro',
        content: 'Hello! I am ready to assist you.',
        clientMessageId,
      })
      .expect(201);

    expect(res.body.status).toBe('sent');
    expect(res.body.messageId).toMatch(/^[a-f0-9-]{36}$/);

    await request(app)
      .post('/api/agent/messages')
      .send({
        agentName: 'NewAgentIntro',
        content: 'invalid id must be rejected cleanly',
        clientMessageId: 'not-a-uuid',
      })
      .expect(400)
      .expect((invalidRes) => {
        expect(invalidRes.body.error.code).toBe('VALIDATION_ERROR');
        expect(invalidRes.body.error.message).toMatch(/clientMessageId must be a UUID/);
      });

    await pool.end();
  });

  it('GET /api/agent/responses hands out one run-overrides batch per poll', async () => {
    const { app, query, pool, userId } = await createAgentApiTestContext();
    const agentId = uuidv4();
    await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [agentId, userId, 'BatchBot', 1]);
    const claude = JSON.stringify({ model_provider: 'claude', model: 'claude-sonnet-5' });
    const codex = JSON.stringify({ model_provider: 'codex', model: 'gpt-5.6-terra' });
    const rows = [['one', claude, 1], ['two', claude, 2], ['three', codex, 3], ['four', null, 4]];
    for (const [content, overrides, sec] of rows) {
      await query(
        'INSERT INTO user_messages (user_message_id, agent_id, content, encrypted, run_overrides, created_at) VALUES ($1, $2, $3, FALSE, $4::jsonb, $5)',
        [uuidv4(), agentId, content, overrides, new Date(Date.UTC(2026, 0, 1, 0, 0, sec))]
      );
    }

    // pg-mem mis-applies the route's ANY($1) bulk update, so poll with markRead=false and mark
    // the returned batch read explicitly, as the real database does.
    const markRead = async (body) => {
      for (const r of body.responses) {
        await query('UPDATE user_messages SET read_at = NOW()::timestamp WHERE user_message_id = $1', [r.messageId]);
      }
    };
    const first = await request(app).get('/api/agent/responses?agentName=BatchBot&markRead=false').expect(200);
    expect(first.body.responses.map((r) => r.content)).toEqual(['one', 'two']);
    expect(first.body.runOverrides).toEqual({ model_provider: 'claude', model: 'claude-sonnet-5' });

    await markRead(first.body);
    const second = await request(app).get('/api/agent/responses?agentName=BatchBot&markRead=false').expect(200);
    expect(second.body.responses.map((r) => r.content)).toEqual(['three']);
    expect(second.body.runOverrides).toEqual({ model_provider: 'codex', model: 'gpt-5.6-terra' });

    await markRead(second.body);
    const third = await request(app).get('/api/agent/responses?agentName=BatchBot&markRead=false').expect(200);
    expect(third.body.responses.map((r) => r.content)).toEqual(['four']);
    expect(third.body.runOverrides).toBeNull();
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

  it('signals agentDeletedOrArchived when polling a deleted or archived agent and prevents re-creating archived agents', async () => {
    const { app, query, pool, userId } = await createAgentApiTestContext();

    // 1. Deleted/non-existent agent returns agentDeletedOrArchived on /responses
    const deletedRes = await request(app)
      .get('/api/agent/responses')
      .query({ agentName: 'DeletedGhostAgent' })
      .expect(200);
    expect(deletedRes.body).toMatchObject({
      responses: [],
      agentDeletedOrArchived: true,
      agentStatus: 'deleted',
    });

    // 2. Archived agent returns agentDeletedOrArchived: true (status: archived) and blocks POST /api/agent/messages from re-creating it
    await query(
      'INSERT INTO archived_agents (archived_agent_id, agent_id, user_id, agent_name, agent_type) VALUES ($1, $2, $3, $4, $5)',
      [uuidv4(), uuidv4(), userId, 'ArchivedRunnerAgent', 'standard']
    );

    const archivedPollRes = await request(app)
      .get('/api/agent/responses')
      .query({ agentName: 'ArchivedRunnerAgent' })
      .expect(200);
    expect(archivedPollRes.body).toMatchObject({
      responses: [],
      agentDeletedOrArchived: true,
      agentStatus: 'archived',
    });

    const sendRes = await request(app)
      .post('/api/agent/messages')
      .send({
        agentName: 'ArchivedRunnerAgent',
        content: 'Trying to resurrect archived agent',
        encrypted: false,
      })
      .expect(403);
    expect(sendRes.body).toMatchObject({
      agentDeletedOrArchived: true,
      agentStatus: 'archived',
      error: { code: 'AGENT_ARCHIVED' },
    });

    const recreated = await query('SELECT agent_id FROM agents WHERE user_id = $1 AND agent_name = $2', [
      userId,
      'ArchivedRunnerAgent',
    ]);
    expect(recreated.rows).toHaveLength(0);

    await pool.end();
  });
});
