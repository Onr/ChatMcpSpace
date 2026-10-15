const express = require('express');
const session = require('express-session');
const request = require('supertest');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createTestDatabase, applyRuntimeUserColumns, seedUser } = require('../utils/pgMemTestUtils');

const BASE_URL = 'https://chatmcp.space';

async function makeContext({ realRateLimits = false } = {}) {
  jest.resetModules();
  const database = createTestDatabase();
  database.db.public.registerFunction({ name: 'current_schema', returns: 'text', implementation: () => 'public' });
  await applyRuntimeUserColumns(database.query);
  const { userId } = await seedUser(database.query);
  await database.query("UPDATE users SET email_verified = TRUE WHERE user_id = $1", [userId]);
  await database.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/059_add_mcp_oauth.sql'), 'utf8'));
  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => database.query(text, params),
    getClient: async () => database.pool.connect(),
    pool: database.pool
  }));
  if (realRateLimits) {
    jest.dontMock('../../src/middleware/rateLimitMiddleware');
    jest.doMock('../../src/utils/redisClient', () => ({ rateLimitRedisClient: null }));
    jest.doMock('../../src/utils/securityLogger', () => ({ logRateLimitViolation: jest.fn() }));
  } else {
    jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
      createRateLimiter: () => (_req, _res, next) => next()
    }));
  }
  const mcpRoutes = require('../../src/routes/mcpRoutes');
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-session-key-only', resave: false, saveUninitialized: true }));
  app.use((_req, res, next) => {
    res.locals.cspNonce = 'test-nonce';
    res.setHeader('Content-Security-Policy', "default-src 'self';form-action 'self';script-src 'self' 'nonce-test-nonce'");
    next();
  });
  app.get('/login', (req, res) => {
    req.session.userId = userId;
    return res.redirect(req.session.mcpOAuthReturnTo || '/');
  });
  app.get('/test-account/:userId', (req, res) => {
    req.session.userId = req.params.userId;
    res.status(204).end();
  });
  if (realRateLimits) {
    const { authRateLimiter } = require('../../src/middleware/rateLimitMiddleware');
    app.get('/test-password-quota', authRateLimiter, (_req, res) => res.status(200).end());
  }
  app.use('/', mcpRoutes);
  const previousBaseUrl = process.env.BASE_URL;
  process.env.BASE_URL = BASE_URL;
  return {
    app, database, userId,
    cleanup: async () => {
      if (previousBaseUrl === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previousBaseUrl;
      await database.pool.end();
      jest.resetModules();
    }
  };
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

describe('Gemini MCP OAuth and Streamable HTTP routes', () => {
  it('hands browser consent to a safe GET and recovers an identical repeated submission without issuing another code', async () => {
    const context = await makeContext();
    try {
      const callback = 'https://oauth-redirect.googleusercontent.com/r/browser-handoff-test';
      const { body: client } = await request(context.app).post('/oauth/register')
        .send({ client_name: 'Browser handoff test', redirect_uris: [callback] }).expect(201);
      const browser = request.agent(context.app);
      await browser.get(`/test-account/${context.userId}`).expect(204);
      const page = await browser.get('/oauth/authorize').query({
        client_id: client.client_id, redirect_uri: callback, response_type: 'code',
        code_challenge: pkceChallenge('V'.repeat(43)), code_challenge_method: 'S256',
        resource: `${BASE_URL}/mcp`, state: 'S'.repeat(1078)
      }).expect(200);
      const form = {
        _csrf: page.text.match(/name="_csrf" value="([^"]+)"/)[1],
        authorize_id: page.text.match(/name="authorize_id" value="([^"]+)"/)[1],
        decision: 'allow'
      };
      const approved = await browser.post('/oauth/authorize/consent').set('Accept', 'text/html')
        .type('form').send(form).expect(303);
      const destination = approved.headers.location;
      expect(destination).toMatch(/^\/oauth\/authorize\/complete\?authorize_id=/);
      const completed = await browser.get(destination).expect(200);
      expect(completed.headers['cache-control']).toBe('no-store');
      expect(completed.text).toContain('window.location.replace(');
      expect(completed.text).toContain('nonce="test-nonce"');
      expect(completed.text).toContain('Continue to connected app');
      expect(completed.headers['content-security-policy']).toContain("form-action 'self';");
      await browser.post('/oauth/authorize/consent').set('Accept', 'text/html')
        .type('form').send(form).expect(303).expect('Location', destination);
      expect((await context.database.query('SELECT code_hash FROM mcp_oauth_codes')).rows).toHaveLength(1);
      await browser.post('/oauth/authorize/consent').set('Accept', 'text/html')
        .type('form').send({ ...form, _csrf: 'wrong' }).expect(400);
      await browser.post('/oauth/authorize/consent').set('Accept', 'text/html')
        .type('form').send({ ...form, decision: 'deny' }).expect(400);
      await request(context.app).get(destination).expect(400);
      await browser.get('/oauth/authorize/complete?authorize_id=wrong').expect(400);
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000 + 1);
      try { await browser.get(destination).expect(400); } finally { clock.mockRestore(); }
      const recovery = await browser.get('/oauth/authorize/consent').expect(400);
      expect(recovery.text).toContain('View connection instructions');
    } finally { await context.cleanup(); }
  });

  it('completes OAuth bursts independently of password attempts while retaining operation limits', async () => {
    const context = await makeContext({ realRateLimits: true });
    try {
      for (let i = 0; i < 6; i++) await request(context.app).get('/test-password-quota').expect(200);
      await request(context.app).get('/test-password-quota').expect(429);
      const callback = 'https://oauth-redirect.googleusercontent.com/r/mcp-rate-test';
      const registered = await request(context.app).post('/oauth/register')
        .send({ client_name: 'Gemini burst test', redirect_uris: [callback] }).expect(201);
      expect(registered.headers['x-ratelimit-scope']).toBe('mcp-registration');
      const clientId = registered.body.client_id;
      const verifier = 'R'.repeat(43);
      const parameters = {
        response_type: 'code', client_id: clientId, redirect_uri: callback,
        code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
        resource: `${BASE_URL}/mcp`, scope: 'agents.read', state: 'S'.repeat(1078)
      };
      const browser = request.agent(context.app);
      await browser.get(`/test-account/${context.userId}`).expect(204);
      let page;
      for (let i = 0; i < 8; i++) {
        page = await browser.get('/oauth/authorize').query(parameters).expect(200);
        expect(page.headers['x-ratelimit-scope']).toBe('mcp-authorization');
      }
      const consent = await browser.post('/oauth/authorize/consent').type('form').send({
        _csrf: page.text.match(/name="_csrf" value="([^"]+)"/)[1],
        authorize_id: page.text.match(/name="authorize_id" value="([^"]+)"/)[1],
        decision: 'allow'
      }).expect(303);
      const code = new URL(consent.headers.location).searchParams.get('code');
      const exchange = await request(context.app).post('/oauth/token').type('form').send({
        grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: callback,
        code_verifier: verifier, resource: `${BASE_URL}/mcp`
      }).expect(200);
      expect(exchange.headers['x-ratelimit-scope']).toBe('mcp-token');
      let tokens = exchange.body;
      for (let i = 0; i < 8; i++) {
        const refreshed = await request(context.app).post('/oauth/token').type('form').send({
          grant_type: 'refresh_token', client_id: clientId,
          refresh_token: tokens.refresh_token, resource: `${BASE_URL}/mcp`
        }).expect(200);
        tokens = refreshed.body;
      }
      const revocation = await request(context.app).post('/oauth/revoke').type('form').send({
        client_id: clientId, token: tokens.refresh_token, token_type_hint: 'refresh_token'
      }).expect(200);
      expect(revocation.headers['x-ratelimit-scope']).toBe('mcp-revocation');
      await request(context.app).post('/mcp').set('Authorization', `Bearer ${tokens.access_token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' }).expect(401);
      for (let i = 1; i < 20; i++) {
        await request(context.app).post('/oauth/register')
          .send({ client_name: 'Bounded registration test', redirect_uris: [callback] }).expect(201);
      }
      await request(context.app).post('/oauth/register')
        .send({ client_name: 'Over quota', redirect_uris: [callback] }).expect(429);
      await browser.get('/oauth/authorize').query(parameters).expect(200);
      await request(context.app).get('/test-password-quota').expect(429);
    } finally { await context.cleanup(); }
  });

  it('publishes protected-resource and authorization-server metadata for /mcp', async () => {
    const context = await makeContext();
    try {
      const resource = await request(context.app).get('/.well-known/oauth-protected-resource').expect(200);
      expect(resource.body).toMatchObject({
        resource: `${BASE_URL}/mcp`, authorization_servers: [BASE_URL],
        bearer_methods_supported: ['header'], scopes_supported: ['agents.read']
      });
      const endpoint = await request(context.app).get('/.well-known/oauth-protected-resource/mcp').expect(200);
      expect(endpoint.body.resource).toBe(`${BASE_URL}/mcp`);
      const authorizationServer = await request(context.app).get('/.well-known/oauth-authorization-server').expect(200);
      expect(authorizationServer.body).toMatchObject({
        issuer: BASE_URL, authorization_endpoint: `${BASE_URL}/oauth/authorize`,
        token_endpoint: `${BASE_URL}/oauth/token`, registration_endpoint: `${BASE_URL}/oauth/register`,
        revocation_endpoint: `${BASE_URL}/oauth/revoke`, code_challenge_methods_supported: ['S256']
      });
    } finally { await context.cleanup(); }
  });

  it('registers a public client, resumes sign-in, obtains consent, exchanges PKCE once, and limits MCP results to that account', async () => {
    const context = await makeContext();
    try {
      const secondUser = await seedUser(context.database.query, { email: 'other@example.com' });
      const ownAgentId = '10000000-0000-4000-8000-000000000001';
      const otherAgentId = '10000000-0000-4000-8000-000000000002';
      await context.database.query('INSERT INTO agents (agent_id,user_id,agent_name,position) VALUES ($1,$2,$3,1),($4,$5,$6,1)',
        [ownAgentId, context.userId, 'Visible agent', otherAgentId, secondUser.userId, 'Private agent']);

      const callback = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-verification-chatmcp_space';
      const state = 'G'.repeat(1078);
      const registered = await request(context.app).post('/oauth/register').send({
        client_name: 'Gemini', redirect_uris: [callback]
      }).expect(201);
      const clientId = registered.body.client_id;
      const verifier = 'A'.repeat(43);
      const challenge = pkceChallenge(verifier);
      const authorize = `/oauth/authorize?${new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: callback,
        code_challenge: challenge, code_challenge_method: 'S256',
        resource: `${BASE_URL}/mcp`, scope: 'agents.read', state
      })}`;
      const browser = request.agent(context.app);
      await browser.get(authorize).expect(302).expect('Location', '/login');
      const consentPage = await browser.get('/login').expect(302);
      expect(consentPage.headers.location).toContain('/oauth/authorize?');
      const form = await browser.get(authorize).expect(200);
      expect(form.headers['content-security-policy']).toContain("form-action 'self'");
      expect(form.headers['content-security-policy']).toContain("script-src 'self'");
      expect(form.headers['content-security-policy']).not.toContain('https://attacker.example');
      const csrfToken = form.text.match(/name="_csrf" value="([^"]+)"/)[1];
      const authorizeId = form.text.match(/name="authorize_id" value="([^"]+)"/)[1];
      const consent = await browser.post('/oauth/authorize/consent').type('form').send({
        _csrf: csrfToken, authorize_id: authorizeId, decision: 'allow'
      }).expect(303);
      const callbackUrl = new URL(consent.headers.location);
      expect(callbackUrl.searchParams.get('state')).toBe(state);
      const code = callbackUrl.searchParams.get('code');

      await request(context.app).post('/oauth/token').type('form').send({
        grant_type: 'authorization_code', client_id: clientId, code,
        redirect_uri: 'https://attacker.example/callback', code_verifier: verifier, resource: `${BASE_URL}/mcp`
      }).expect(400).expect(({ body }) => expect(body.error).toBe('invalid_grant'));
      await request(context.app).post('/oauth/token').type('form').send({
        grant_type: 'authorization_code', client_id: clientId, code,
        redirect_uri: callback, code_verifier: verifier, resource: 'https://wrong.example/mcp'
      }).expect(400).expect(({ body }) => expect(body.error).toBe('invalid_target'));
      await request(context.app).post('/oauth/token').type('form').send({
        grant_type: 'authorization_code', client_id: clientId, code,
        redirect_uri: callback, code_verifier: 'C'.repeat(43), resource: `${BASE_URL}/mcp`
      }).expect(400).expect(({ body }) => expect(body.error).toBe('invalid_grant'));

      const exchange = await request(context.app).post('/oauth/token').type('form').send({
        grant_type: 'authorization_code', client_id: clientId, code,
        redirect_uri: callback, code_verifier: verifier, resource: `${BASE_URL}/mcp`
      }).expect(200);
      expect(exchange.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'agents.read' });
      expect(await context.database.query('SELECT access_token_hash, refresh_token_hash FROM mcp_oauth_tokens')).toMatchObject({
        rows: [{ access_token_hash: sha256(exchange.body.access_token), refresh_token_hash: sha256(exchange.body.refresh_token) }]
      });
      await request(context.app).post('/oauth/token').type('form').send({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: exchange.body.refresh_token,
        resource: 'https://wrong.example/mcp'
      }).expect(400).expect(({ body }) => expect(body.error).toBe('invalid_target'));
      const rotated = await request(context.app).post('/oauth/token').type('form').send({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: exchange.body.refresh_token,
        resource: `${BASE_URL}/mcp`
      }).expect(200);
      expect(rotated.body.access_token).not.toBe(exchange.body.access_token);
      await request(context.app).post('/oauth/token').type('form').send({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: exchange.body.refresh_token,
        resource: `${BASE_URL}/mcp`
      }).expect(400).expect(({ body }) => expect(body.error).toBe('invalid_grant'));

      const initialize = await request(context.app).post('/mcp').set('Authorization', `Bearer ${rotated.body.access_token}`).send({
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Gemini', version: 'test' } }
      }).expect(200);
      expect(initialize.body.result).toMatchObject({ protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } } });
      const listed = await request(context.app).post('/mcp').set('Authorization', `Bearer ${rotated.body.access_token}`).send({
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_agents', arguments: {} }
      }).expect(200);
      expect(listed.body.result.structuredContent.agents).toEqual([{ id: ownAgentId, name: 'Visible agent' }]);
      expect(JSON.stringify(listed.body)).not.toContain('Private agent');
      await request(context.app).post('/mcp').set('Authorization', 'Bearer not-a-token').send({
        jsonrpc: '2.0', id: 3, method: 'tools/list'
      }).expect(401);
      await request(context.app).post('/mcp').set('Authorization', `Bearer ${rotated.body.access_token}`)
        .set('MCP-Protocol-Version', '9999-01-01').send({ jsonrpc: '2.0', id: 4, method: 'ping' }).expect(400);
      await request(context.app).post('/mcp').set('Authorization', `Bearer ${rotated.body.access_token}`)
        .send({ jsonrpc: '2.0', method: 'ping' }).expect(202);
      await request(context.app).post('/mcp').set('Authorization', `Bearer ${rotated.body.access_token}`)
        .send({ jsonrpc: '2.0', id: null, method: 'ping' }).expect(400);
      const notification = await request(context.app).post('/mcp').set('Authorization', `Bearer ${rotated.body.access_token}`)
        .send({ jsonrpc: '2.0', method: 'tools/list' }).expect(202);
      expect(notification.text).toBe('');
      await request(context.app).post('/mcp').set('Authorization', `Bearer ${rotated.body.access_token}`)
        .set('Origin', 'https://evil.example').send({ jsonrpc: '2.0', id: 5, method: 'ping' }).expect(403);

      await context.database.query('UPDATE mcp_oauth_tokens SET expires_at = $1 WHERE refresh_token_hash = $2',
        [new Date(Date.now() - 60_000), sha256(rotated.body.refresh_token)]);
      await request(context.app).post('/mcp').set('Authorization', `Bearer ${rotated.body.access_token}`)
        .send({ jsonrpc: '2.0', id: 6, method: 'ping' }).expect(401);
      await context.database.query('UPDATE mcp_oauth_tokens SET expires_at = $1 WHERE refresh_token_hash = $2',
        [new Date(Date.now() + 60_000), sha256(rotated.body.refresh_token)]);
      await request(context.app).post('/oauth/revoke').type('form').send({
        client_id: clientId, token: rotated.body.refresh_token, token_type_hint: 'refresh_token'
      }).expect(200);
      await request(context.app).post('/oauth/token').type('form').send({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: rotated.body.refresh_token,
        resource: `${BASE_URL}/mcp`
      }).expect(400).expect(({ body }) => expect(body.error).toBe('invalid_grant'));
      await request(context.app).post('/mcp').set('Authorization', `Bearer ${rotated.body.access_token}`)
        .send({ jsonrpc: '2.0', id: 7, method: 'ping' }).expect(401);

      await request(context.app).post('/oauth/token').type('form').send({
        grant_type: 'authorization_code', client_id: clientId, code,
        redirect_uri: callback, code_verifier: verifier, resource: `${BASE_URL}/mcp`
      }).expect(400).expect(({ body }) => expect(body.error).toBe('invalid_grant'));
    } finally { await context.cleanup(); }
  });

  it('accepts long opaque state and rejects oversized or ambiguous state', async () => {
    const context = await makeContext();
    try {
      const callback = 'https://oauth-redirect.googleusercontent.com/r/mcp-verification';
      const { body: client } = await request(context.app).post('/oauth/register').send({
        client_name: 'State compatibility test', redirect_uris: [callback]
      }).expect(201);
      const parameters = {
        response_type: 'code', client_id: client.client_id, redirect_uri: callback,
        code_challenge: pkceChallenge('V'.repeat(43)), code_challenge_method: 'S256',
        resource: `${BASE_URL}/mcp`, scope: 'agents.read'
      };
      for (const length of [1024, 1078, 4096, 8192]) {
        await request(context.app).get('/oauth/authorize')
          .query({ ...parameters, state: 'S'.repeat(length) })
          .expect(302).expect('Location', '/login');
      }
      for (const state of ['', 'S'.repeat(8193), ['one', 'two']]) {
        const response = await request(context.app).get('/oauth/authorize')
          .query({ ...parameters, state }).expect(400);
        expect(response.body.error_description).toMatch(/state must be/);
      }
      const browser = request.agent(context.app);
      const state = 'D'.repeat(1078);
      await browser.get('/login').expect(302);
      const page = await browser.get('/oauth/authorize').query({ ...parameters, state }).expect(200);
      const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
      const id = page.text.match(/name="authorize_id" value="([^"]+)"/)[1];
      const denied = await browser.post('/oauth/authorize/consent').type('form')
        .send({ _csrf: csrf, authorize_id: id, decision: 'deny' }).expect(303);
      const result = new URL(denied.headers.location);
      expect(result.searchParams.get('state')).toBe(state);
      expect(result.searchParams.get('error')).toBe('access_denied');
    } finally { await context.cleanup(); }
  });

  it('rejects weak PKCE, invalid redirect URIs, wrong-resource exchange, bad tokens, and replayed refresh tokens', async () => {
    const context = await makeContext();
    try {
      await request(context.app).post('/oauth/register').send({
        client_name: 'Bad', redirect_uris: ['https://good.example/cb', 'https://evil.example/cb']
      }).expect(201);
      await request(context.app).post('/oauth/register').send({
        client_name: 'Bad redirect', redirect_uris: ['https://user:pass@example.com/callback']
      }).expect(400);
      const { body: client } = await request(context.app).post('/oauth/register').send({
        client_name: 'Gemini', redirect_uris: ['https://gemini.google.com/callback']
      }).expect(201);
      const verifier = 'B'.repeat(43);
      const authorize = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id,
        redirect_uri: 'https://gemini.google.com/callback', code_challenge: pkceChallenge(verifier),
        code_challenge_method: 'plain', resource: `${BASE_URL}/mcp`, state: 'state' })}`;
      await request(context.app).get(authorize).expect(400);
      await request(context.app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'initialize' })
        .expect(401).expect('WWW-Authenticate', /oauth-protected-resource/);
      await request(context.app).get('/mcp').expect(401);
    } finally { await context.cleanup(); }
  });

  it('requires verified email, binds consent to its signed-in account, and honors denial', async () => {
    const context = await makeContext();
    try {
      const unverified = await seedUser(context.database.query, { email: 'unverified@example.com', emailVerified: false });
      const { body: client } = await request(context.app).post('/oauth/register').send({
        client_name: 'Gemini', redirect_uris: ['https://gemini.google.com/callback']
      }).expect(201);
      const verifier = 'D'.repeat(43);
      const authUrl = () => `/oauth/authorize?${new URLSearchParams({
        response_type: 'code', client_id: client.client_id, redirect_uri: 'https://gemini.google.com/callback',
        code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', resource: `${BASE_URL}/mcp`, state: 'state-binding'
      })}`;
      const browser = request.agent(context.app);
      await browser.get(authUrl()).expect(302);
      await browser.get('/login').expect(302);
      await browser.get(`/test-account/${unverified.userId}`).expect(204);
      await browser.get(authUrl()).expect(403);
      await browser.get(`/test-account/${context.userId}`).expect(204);
      const page = await browser.get(authUrl()).expect(200);
      const csrfToken = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
      const authorizeId = page.text.match(/name="authorize_id" value="([^"]+)"/)[1];
      await browser.post('/oauth/authorize/consent').type('form').send({ _csrf: 'wrong', authorize_id: authorizeId, decision: 'allow' }).expect(400);
      const pageAfterBadCsrf = await browser.get(authUrl()).expect(200);
      const newCsrf = pageAfterBadCsrf.text.match(/name="_csrf" value="([^"]+)"/)[1];
      const newAuthorizeId = pageAfterBadCsrf.text.match(/name="authorize_id" value="([^"]+)"/)[1];
      await browser.get(`/test-account/${unverified.userId}`).expect(204);
      await browser.post('/oauth/authorize/consent').type('form').send({ _csrf: newCsrf, authorize_id: newAuthorizeId, decision: 'allow' }).expect(401);
      await browser.get(`/test-account/${context.userId}`).expect(204);
      const denialPage = await browser.get(authUrl()).expect(200);
      const denialCsrf = denialPage.text.match(/name="_csrf" value="([^"]+)"/)[1];
      const denialId = denialPage.text.match(/name="authorize_id" value="([^"]+)"/)[1];
      const denied = await browser.post('/oauth/authorize/consent').type('form').send({ _csrf: denialCsrf, authorize_id: denialId, decision: 'deny' }).expect(303);
      expect(new URL(denied.headers.location).searchParams.get('error')).toBe('access_denied');
      expect((await context.database.query('SELECT code_hash FROM mcp_oauth_codes')).rows).toHaveLength(0);
    } finally { await context.cleanup(); }
  });
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
