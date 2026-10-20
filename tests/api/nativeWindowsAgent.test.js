const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createTestDatabase, applyRuntimeUserColumns, applyArchiveSchema, applyLineageSchema, seedUser } = require('../utils/pgMemTestUtils');

it('creates a native Windows agent through real registration, permissions, enrollment and scoped config APIs with sharing disabled', async () => {
  jest.resetModules();
  const oldSharing = process.env.FEATURE_SHARED_CONVERSATIONS;
  process.env.FEATURE_SHARED_CONVERSATIONS = 'false';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-api-test-'));
  const { pool, query } = createTestDatabase();
  await applyRuntimeUserColumns(query); await applyArchiveSchema(query); await applyLineageSchema(query);
  const { userId, apiKey } = await seedUser(query);
  const salt = crypto.randomBytes(32).toString('base64');
  await query('UPDATE users SET encryption_salt=$1 WHERE user_id=$2', [salt, userId]);
  jest.doMock('../../src/db/connection', () => ({ query, pool, getClient: () => pool.connect() }));
  jest.doMock('../../src/middleware/rateLimitMiddleware', () => {
    const pass = (_req, _res, next) => next();
    return { agentPollingRateLimiter: pass, agentApiRateLimiter: pass, agentMessageIngressRateLimiter: pass, feedbackRateLimiter: pass };
  });
  jest.doMock('../../src/utils/securityLogger', () => ({ logUnauthorizedAccess: jest.fn(), logApiKeyUsage: jest.fn(), logRateLimitViolation: jest.fn() }));
  const app = express(); app.use(express.json()); app.use('/api/agent', require('../../src/routes/agentApiRoutes'));
  const fetchImpl = async (url, options = {}) => {
    const endpoint = new URL(url);
    const method = (options.method || 'GET').toLowerCase();
    let req = request(app)[method](endpoint.pathname + endpoint.search);
    for (const [name, value] of Object.entries(options.headers || {})) req = req.set(name, value);
    if (options.body) req = req.send(JSON.parse(options.body));
    const result = await req;
    return { ok: result.status >= 200 && result.status < 300, status: result.status, headers: new Headers(result.headers), json: async () => result.body };
  };
  try {
    const { initialize, makeBridge } = require('../../scripts/windows-agent-runner');
    const { loadState } = require('../../scripts/external-agent-bridge');
    const created = await initialize(root, { baseUrl: 'https://example.test', agentName: 'Native Windows Fixture', project: root, provider: 'codex', apiKey, password: 'encryption-password', allowEdits: true }, { fetchImpl, resolve: () => ({ command: 'node', prefix: [] }) });
    const state = loadState(created.file);
    const config = await makeBridge(state, created.file, { fetchImpl }).api(`/config?agentName=${encodeURIComponent(state.agentName)}`);
    expect(config.config.model_provider).toBe('codex');
    expect(config.config.sandbox_mode).toBe('workspace-write');
    expect(config.allowedPermissions.codex['--sandbox']).toEqual(['read-only', 'workspace-write']);
    expect(config.interAgentMode).toBe('listen_all');
    expect(state.key).toBe(crypto.pbkdf2Sync('encryption-password', Buffer.from(salt, 'base64'), 100000, 32, 'sha256').toString('base64'));
    expect(state.token).toMatch(/^agt_/);
    const stored = await query('SELECT scopes_json FROM agent_api_credentials WHERE agent_id=$1', [state.agentId]);
    expect(stored.rows[0].scopes_json).toContain('agent.responses.read');
  } finally {
    if (oldSharing === undefined) delete process.env.FEATURE_SHARED_CONVERSATIONS; else process.env.FEATURE_SHARED_CONVERSATIONS = oldSharing;
    fs.rmSync(root, { recursive: true, force: true }); await pool.end(); jest.resetModules(); jest.clearAllMocks();
  }
});
