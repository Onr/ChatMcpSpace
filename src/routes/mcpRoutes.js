const crypto = require('crypto');
const express = require('express');
const { query, getClient } = require('../db/connection');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const { safeJsonForScript } = require('../utils/safeJsonHelper');

// OAuth handshakes contain multiple requests and must not consume the
// password-login quota. Keep separate bounded budgets for each operation.
const registrationLimiter = createRateLimiter({ windowMs: 60000, max: 20, keyPrefix: 'mcp-registration' });
const authorizationLimiter = createRateLimiter({ windowMs: 60000, max: 60, keyPrefix: 'mcp-authorization' });
const tokenLimiter = createRateLimiter({ windowMs: 60000, max: 120, keyPrefix: 'mcp-token' });
const revocationLimiter = createRateLimiter({ windowMs: 60000, max: 60, keyPrefix: 'mcp-revocation' });

const router = express.Router();
const ACCESS_TTL_SECONDS = 900;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
// OAuth state is opaque client data. Gemini uses values larger than 1 KiB.
const MAX_OAUTH_STATE_LENGTH = 8192;
const SUPPORTED_PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);
const SCOPE = 'agents.read';

function getBaseUrl(req) {
  const configured = process.env.BASE_URL;
  if (!configured && process.env.NODE_ENV === 'production') throw new Error('BASE_URL must be configured for MCP OAuth in production.');
  const raw = configured || `${req.protocol}://${req.get('host')}`;
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('BASE_URL must be a valid public origin without credentials, path, or query values.');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('MCP OAuth requires an HTTPS BASE_URL in production.');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function isSafeRedirectUri(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || url.hash ||
        !/^https?:\/\/[a-zA-Z0-9.:[\]-]+$/.test(url.origin)) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch (_error) {
    return false;
  }
}

function oauthError(res, status, code, description) {
  res.set('Cache-Control', 'no-store').status(status).json({ error: code, error_description: description });
}

function safeConsentHtml({ clientName, scope, csrfToken, authorizeId }) {
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to ChatMCP</title><style>body{font:16px system-ui;background:#111827;color:#e5e7eb;margin:0;padding:2rem}.card{max-width:34rem;margin:8vh auto;background:#1f2937;border:1px solid #374151;border-radius:1rem;padding:2rem}button{padding:.75rem 1rem;border:0;border-radius:.5rem;background:#059669;color:white;font-weight:700;cursor:pointer}a{color:#6ee7b7}.muted{color:#9ca3af}</style></head><body><main class="card"><h1>Connect ${escape(clientName)} to ChatMCP</h1><p>This app will be able to view the names and IDs of agents in your account.</p><p class="muted">It cannot read chat messages or access encryption keys.</p><form method="post" action="/oauth/authorize/consent"><input type="hidden" name="_csrf" value="${escape(csrfToken)}"><input type="hidden" name="authorize_id" value="${escape(authorizeId)}"><button name="decision" value="allow">Allow access</button> <button name="decision" value="deny" formnovalidate>Cancel</button></form><p class="muted"><a href="/privacy">Privacy policy</a></p></main></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function consentUnavailable(res) {
  return res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    .status(400).type('html').send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Restart your connection</title></head><body><h1>Restart your connection</h1><p>This approval form has already been used or is no longer available. Return to Gemini and start a new connection.</p><p><a href="/mcp-guide">View connection instructions</a></p></body></html>');
}

function finishConsent(req, res, completed) {
  req.session.mcpCompletedAuthorization = completed;
  // Commit a same-origin document before returning to the client. Keeping the
  // provider's redirect chain inside a form navigation can trigger form-action.
  if (req.get('accept')?.includes('text/html')) {
    return res.redirect(303, `/oauth/authorize/complete?authorize_id=${encodeURIComponent(completed.id)}`);
  }
  return res.redirect(303, completed.callbackUrl);
}

router.get('/oauth/authorize/complete', (req, res) => {
  const completed = req.session?.mcpCompletedAuthorization;
  if (!completed || req.query.authorize_id !== completed.id ||
      req.session.userId !== completed.userId || Date.now() > completed.expiresAt) {
    return consentUnavailable(res);
  }
  const nonce = res.locals.cspNonce;
  const script = nonce
    ? `<script nonce="${escapeHtml(nonce)}">window.location.replace(${safeJsonForScript(completed.callbackUrl)});</script>`
    : '';
  return res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).type('html')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Returning to your app</title></head><body><h1>Returning to your app</h1><p>Your decision has been saved.</p><p><a href="${escapeHtml(completed.callbackUrl)}">Continue to connected app</a></p>${script}</body></html>`);
});

router.get('/oauth/authorize/consent', (_req, res) => consentUnavailable(res));

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = getBaseUrl(req);
  res.set('Cache-Control', 'public, max-age=300').json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_documentation: `${base}/mcp-guide`
  });
});
router.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  const base = getBaseUrl(req);
  res.set('Cache-Control', 'public, max-age=300').json({
    resource: `${base}/mcp`, authorization_servers: [base],
    bearer_methods_supported: ['header'], scopes_supported: [SCOPE],
    resource_documentation: `${base}/mcp-guide`
  });
});

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = getBaseUrl(req);
  res.set('Cache-Control', 'public, max-age=300').json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    revocation_endpoint: `${base}/oauth/revoke`,
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE]
  });
});

router.get('/mcp-guide', (req, res) => {
  const endpoint = `${getBaseUrl(req)}/mcp`;
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Gemini to ChatMCP</title><style>body{font:16px system-ui;max-width:48rem;margin:3rem auto;padding:0 1.25rem;background:#0f172a;color:#e2e8f0}code{background:#1e293b;padding:.2rem .4rem;border-radius:.3rem}a{color:#6ee7b7}</style></head><body><h1>Connect Gemini to ChatMCP</h1><ol><li>In Gemini, choose <strong>Connect to an MCP server</strong>.</li><li>Enter this MCP server URL: <code>${escapeHtml(endpoint)}</code></li><li>Continue to ChatMCP, sign in, and approve access.</li></ol><p>The current integration provides a read-only list of your agent names and IDs. It does not expose messages, account API keys, or encryption keys.</p><p><a href="/settings">Account settings</a></p></body></html>`);
});

router.post('/oauth/register', registrationLimiter, async (req, res) => {
  const { client_name: rawName, redirect_uris: redirectUris } = req.body || {};
  const clientName = typeof rawName === 'string' ? rawName.trim().slice(0, 120) : '';
  if (!clientName || !Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 10 ||
      redirectUris.some(uri => !isSafeRedirectUri(uri)) || new Set(redirectUris).size !== redirectUris.length) {
    return oauthError(res, 400, 'invalid_client_metadata', 'Provide a client_name and 1-10 valid HTTPS or loopback redirect_uris.');
  }
  try {
    const clientId = randomToken();
    await query('INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3::jsonb)', [clientId, clientName, JSON.stringify(redirectUris)]);
    return res.set('Cache-Control', 'no-store').status(201).json({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    });
  } catch (error) {
    console.error('MCP OAuth client registration failed:', error.message);
    return oauthError(res, 500, 'server_error', 'Client registration failed.');
  }
});

router.get('/oauth/authorize', authorizationLimiter, async (req, res) => {
  const { client_id: clientId, redirect_uri: redirectUri, response_type: responseType,
    code_challenge: codeChallenge, code_challenge_method: method, resource, state } = req.query;
  const base = getBaseUrl(req);
  const requestedScopes = String(req.query.scope || SCOPE).split(/\s+/).filter(Boolean);
  if (typeof state !== 'string' || !state.length || state.length > MAX_OAUTH_STATE_LENGTH) {
    return oauthError(res, 400, 'invalid_request', `state must be a non-empty string of at most ${MAX_OAUTH_STATE_LENGTH} characters.`);
  }
  if (responseType !== 'code' || !clientId || !redirectUri ||
      !codeChallenge || method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(codeChallenge)) ||
      resource !== `${base}/mcp` || requestedScopes.some(scope => scope !== SCOPE)) {
    return oauthError(res, 400, 'invalid_request', 'Authorization code flow, S256 PKCE, state, redirect_uri, and the canonical MCP resource are required.');
  }
  try {
    const result = await query('SELECT client_name, redirect_uris FROM mcp_oauth_clients WHERE client_id = $1', [clientId]);
    const client = result.rows[0];
    if (!client || !client.redirect_uris.includes(redirectUri)) return oauthError(res, 400, 'invalid_request', 'Client or redirect URI is not registered.');

    if (!req.session?.userId) {
      req.session.mcpOAuthReturnTo = req.originalUrl;
      req.session.mcpOAuthReturnToExpiresAt = Date.now() + CODE_TTL_MS;
      return res.redirect(302, '/login');
    }
    const accountResult = await query('SELECT email_verified FROM users WHERE user_id = $1', [req.session.userId]);
    if (!accountResult.rows[0] || accountResult.rows[0].email_verified !== true) {
      return res.status(403).type('text').send('Verify your ChatMCP account email before connecting an MCP app.');
    }
    const authorizeId = randomToken();
    const csrfToken = randomToken();
    req.session.mcpPendingAuthorization = {
      id: authorizeId, clientId, clientName: client.client_name, redirectUri,
      codeChallenge: String(codeChallenge), resource: `${base}/mcp`,
      scope: SCOPE, state: String(state), csrfToken, userId: req.session.userId,
      expiresAt: Date.now() + CODE_TTL_MS
    };
    return res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
      .type('html').send(safeConsentHtml({ clientName: client.client_name, scope: SCOPE, csrfToken, authorizeId }));
  } catch (error) {
    console.error('MCP OAuth authorization failed:', error.message);
    return oauthError(res, 500, 'server_error', 'Authorization failed.');
  }
});

router.post('/oauth/authorize/consent', authorizationLimiter, async (req, res) => {
  const pending = req.session?.mcpPendingAuthorization;
  if (!pending || Date.now() > pending.expiresAt || req.body?.authorize_id !== pending.id || req.body?._csrf !== pending.csrfToken) {
    const completed = req.session?.mcpCompletedAuthorization;
    if (completed && Date.now() <= completed.expiresAt && req.session.userId === completed.userId &&
        req.body?.authorize_id === completed.id && req.body?._csrf === completed.csrfToken &&
        req.body?.decision === completed.decision) {
      return finishConsent(req, res, completed);
    }
    return consentUnavailable(res);
  }
  if (!req.session?.userId || req.session.userId !== pending.userId) return res.status(401).type('text').send('Please sign in to the same account and restart the connection.');
  const callback = new URL(pending.redirectUri);
  callback.searchParams.set('state', pending.state);
  const completed = {
    id: pending.id, userId: pending.userId, csrfToken: pending.csrfToken,
    decision: req.body.decision, expiresAt: Date.now() + CODE_TTL_MS
  };
  if (req.body.decision !== 'allow') {
    callback.searchParams.set('error', 'access_denied');
    delete req.session.mcpPendingAuthorization;
    return finishConsent(req, res, { ...completed, callbackUrl: callback.toString() });
  }
  try {
    const account = await query('SELECT email_verified FROM users WHERE user_id = $1', [pending.userId]);
    if (account.rows[0]?.email_verified !== true) return res.status(403).type('text').send('Verify your ChatMCP account email before connecting an MCP app.');
    const code = randomToken();
    await query(`INSERT INTO mcp_oauth_codes
      (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [sha256(code), pending.clientId, req.session.userId, pending.redirectUri, pending.codeChallenge, pending.resource, SCOPE, new Date(Date.now() + CODE_TTL_MS)]);
    callback.searchParams.set('code', code);
    delete req.session.mcpPendingAuthorization;
    return finishConsent(req, res, { ...completed, callbackUrl: callback.toString() });
  } catch (error) {
    console.error('MCP OAuth consent failed:', error.message);
    return res.status(500).type('text').send('Authorization could not be completed. Please try again.');
  }
});

router.post('/oauth/token', tokenLimiter, async (req, res) => {
  const { grant_type: grantType, client_id: clientId, code, redirect_uri: redirectUri,
    code_verifier: verifier, resource, refresh_token: refreshToken } = req.body || {};
  const base = getBaseUrl(req);
  if (resource !== `${base}/mcp`) return oauthError(res, 400, 'invalid_target', 'The resource must be this MCP server.');
  try {
    let identity;
    if (grantType === 'authorization_code') {
      if (!code || !redirectUri || !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
        return oauthError(res, 400, 'invalid_request', 'Authorization code, redirect_uri, and a valid PKCE verifier are required.');
      }
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const accessToken = randomToken();
      const nextRefreshToken = randomToken();
      const now = new Date();
      const client = await getClient();
      try {
        await client.query('BEGIN');
        const consumed = await client.query(`UPDATE mcp_oauth_codes SET consumed_at = $6
          WHERE code_hash = $1 AND client_id = $2 AND redirect_uri = $3 AND resource = $4
            AND code_challenge = $5 AND consumed_at IS NULL AND expires_at > $7
          RETURNING user_id, client_id, resource, scope`,
        [sha256(code), clientId, redirectUri, resource, challenge, now, now]);
        identity = consumed.rows[0];
        if (!identity) {
          await client.query('ROLLBACK');
          return oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used.');
        }
        await client.query(`INSERT INTO mcp_oauth_tokens
          (access_token_hash, refresh_token_hash, client_id, user_id, resource, scope, expires_at, refresh_expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [sha256(accessToken), sha256(nextRefreshToken), identity.client_id, identity.user_id, identity.resource, identity.scope,
          new Date(Date.now() + ACCESS_TTL_SECONDS * 1000), new Date(Date.now() + REFRESH_TTL_MS)]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      return res.set('Cache-Control', 'no-store').json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: nextRefreshToken, scope: identity.scope });
    } else if (grantType === 'refresh_token') {
      if (!refreshToken) return oauthError(res, 400, 'invalid_request', 'refresh_token is required.');
      const newAccessToken = randomToken();
      const newRefreshToken = randomToken();
      const now = new Date();
      const rotated = await query(`UPDATE mcp_oauth_tokens
        SET access_token_hash = $1, refresh_token_hash = $2, expires_at = $3
        WHERE refresh_token_hash = $4 AND client_id = $5 AND resource = $6
          AND revoked_at IS NULL AND refresh_expires_at > $7
        RETURNING user_id, client_id, resource, scope`,
      [sha256(newAccessToken), sha256(newRefreshToken), new Date(Date.now() + ACCESS_TTL_SECONDS * 1000), sha256(refreshToken), clientId, resource, now]);
      identity = rotated.rows[0];
      if (!identity) return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid, expired, or already rotated.');
      return res.set('Cache-Control', 'no-store').json({ access_token: newAccessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: newRefreshToken, scope: identity.scope });
    } else {
      return oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
    }

  } catch (error) {
    console.error('MCP OAuth token exchange failed:', error.message);
    return oauthError(res, 500, 'server_error', 'Token exchange failed.');
  }
});

router.post('/oauth/revoke', revocationLimiter, async (req, res) => {
  const { token, token_type_hint: hint, client_id: clientId } = req.body || {};
  if (!token || !clientId || !['access_token', 'refresh_token', undefined].includes(hint)) {
    return oauthError(res, 400, 'invalid_request', 'token and client_id are required.');
  }
  try {
    const tokenHash = sha256(token);
    const revokedAt = new Date();
    if (!hint || hint === 'access_token') {
      await query('UPDATE mcp_oauth_tokens SET revoked_at = $3 WHERE access_token_hash = $1 AND client_id = $2 AND revoked_at IS NULL', [tokenHash, clientId, revokedAt]);
    }
    if (!hint || hint === 'refresh_token') {
      await query('UPDATE mcp_oauth_tokens SET revoked_at = $3 WHERE refresh_token_hash = $1 AND client_id = $2 AND revoked_at IS NULL', [tokenHash, clientId, revokedAt]);
    }
    return res.set('Cache-Control', 'no-store').status(200).end();
  } catch (error) {
    console.error('MCP OAuth token revocation failed:', error.message);
    return oauthError(res, 500, 'server_error', 'Token revocation failed.');
  }
});

function jsonRpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function jsonRpcError(id, code, message) { return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }; }

async function authenticateMcp(req, res, next) {
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/i.exec(req.get('authorization') || '');
  if (!match) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${getBaseUrl(req)}/.well-known/oauth-protected-resource", scope="${SCOPE}"`);
    return res.status(401).json({ error: 'invalid_token', error_description: 'A valid bearer token is required.' });
  }
  try {
    const now = new Date();
    const result = await query(`SELECT user_id, resource, scope FROM mcp_oauth_tokens
      WHERE access_token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`, [sha256(match[1]), now]);
    const token = result.rows[0];
    if (!token || token.resource !== `${getBaseUrl(req)}/mcp`) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${getBaseUrl(req)}/.well-known/oauth-protected-resource", scope="${SCOPE}", error="invalid_token"`);
      return res.status(401).json({ error: 'invalid_token', error_description: 'The access token is invalid or expired.' });
    }
    if (!token.scope.split(/\s+/).includes(SCOPE)) return res.status(403).json({ error: 'insufficient_scope' });
    req.mcpUserId = token.user_id;
    return next();
  } catch (error) {
    console.error('MCP token validation failed:', error.message);
    return res.status(500).json({ error: 'server_error' });
  }
}

router.post('/mcp', authenticateMcp, async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const body = req.body;
  if (!body || Array.isArray(body) || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return res.status(400).json(jsonRpcError(body?.id, -32600, 'Invalid Request'));
  }
  if (body.id !== undefined && (body.id === null || !['string', 'number'].includes(typeof body.id))) {
    return res.status(400).json(jsonRpcError(null, -32600, 'Invalid Request'));
  }
  const protocolVersion = req.get('mcp-protocol-version');
  if (protocolVersion && !SUPPORTED_PROTOCOLS.has(protocolVersion)) {
    return res.status(400).json(jsonRpcError(body.id, -32600, 'Unsupported MCP-Protocol-Version'));
  }
  const origin = req.get('origin');
  if (origin && origin !== new URL(getBaseUrl(req)).origin) return res.status(403).json(jsonRpcError(body.id, -32000, 'Origin not allowed'));
  if (body.id === undefined) return res.status(202).end();
  if (body.method === 'initialize') {
    const version = SUPPORTED_PROTOCOLS.has(body.params?.protocolVersion) ? body.params.protocolVersion : '2025-11-25';
    return res.type('application/json').json(jsonRpcResult(body.id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'ChatMCP.Space', version: '1.0.0' }
    }));
  }
  if (body.method === 'ping') return res.type('application/json').json(jsonRpcResult(body.id, {}));
  if (body.method === 'tools/list') {
    return res.type('application/json').json(jsonRpcResult(body.id, { tools: [{
      name: 'list_agents',
      description: 'List the names and IDs of agents in the connected ChatMCP account. No chat content or encryption keys are returned.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false }
    }] }));
  }
  if (body.method === 'tools/call') {
    if (body.params?.name !== 'list_agents') return res.type('application/json').json(jsonRpcError(body.id, -32602, 'Unknown tool'));
    if (body.params?.arguments !== undefined && (!body.params.arguments || typeof body.params.arguments !== 'object' || Array.isArray(body.params.arguments) || Object.keys(body.params.arguments).length)) {
      return res.type('application/json').json(jsonRpcError(body.id, -32602, 'list_agents does not accept arguments'));
    }
    try {
      const agents = await query('SELECT agent_id, agent_name FROM agents WHERE user_id = $1 ORDER BY position, agent_name', [req.mcpUserId]);
      const list = agents.rows.map(agent => ({ id: agent.agent_id, name: agent.agent_name }));
      return res.type('application/json').json(jsonRpcResult(body.id, {
        content: [{ type: 'text', text: JSON.stringify(list) }],
        structuredContent: { agents: list },
        isError: false
      }));
    } catch (error) {
      console.error('MCP agent listing failed:', error.message);
      return res.type('application/json').json(jsonRpcResult(body.id, {
        content: [{ type: 'text', text: 'Unable to list agents right now.' }], isError: true
      }));
    }
  }
  if (body.method === 'resources/list') return res.type('application/json').json(jsonRpcResult(body.id, { resources: [] }));
  if (body.method === 'prompts/list') return res.type('application/json').json(jsonRpcResult(body.id, { prompts: [] }));
  return res.type('application/json').json(jsonRpcError(body.id, -32601, 'Method not found'));
});

router.get('/mcp', authenticateMcp, (req, res) => {
  res.set('Allow', 'POST').status(405).json({ error: 'Streamable HTTP requests must use POST.' });
});

module.exports = router;
module.exports._test = { isSafeRedirectUri, sha256 };
