const crypto = require('crypto');
const express = require('express');
const { query, getClient } = require('../db/connection');
const { createRateLimiter } = require('../middleware/rateLimitMiddleware');
const { safeJsonForScript } = require('../utils/safeJsonHelper');
const hostedMcp = require('../services/mcpHostedService');
const messageBroker = require('../services/mcpMessageBroker');
const { issueScopedCredential } = require('../services/agentCredentialService');

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
const MESSAGE_SCOPES = ['messages.read', 'messages.write', 'peers.read', 'peers.write', 'attachments.read', 'attachments.write'];
const SUPPORTED_SCOPES = new Set([SCOPE, ...MESSAGE_SCOPES]);
// Offer optional collaboration on the same approval screen. Consent removes
// peer scopes unless the user explicitly checks the collaboration option.
const DEFAULT_REQUESTED_SCOPES = [SCOPE, ...MESSAGE_SCOPES];
const AUTH_SCOPE_HINT = DEFAULT_REQUESTED_SCOPES.join(' ');

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
function byteLength(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

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

function safeConsentHtml({ clientName, scopes, csrfToken, authorizeId, agents = [] }) {
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const wantsMessages = scopes.some(scope => MESSAGE_SCOPES.includes(scope));
  const choices = agents.map(agent => `<option value="${escape(agent.agent_id)}" ${agent.eligible ? '' : 'disabled'}>${escape(agent.agent_name)}${agent.eligible ? '' : ' (active listener)'}</option>`).join('');
  const permissionLabels = {
    'agents.read': 'See agent names', 'messages.read': 'Read the selected agent’s messages',
    'messages.write': 'Send replies to you', 'peers.read': 'Read messages from permitted peers (optional below)',
    'peers.write': 'Send messages to permitted peers (optional below)',
    'attachments.read': 'Read attached images and files', 'attachments.write': 'Upload and send files'
  };
  const permissions = scopes.map(scope => `<li>${escape(permissionLabels[scope] || scope)}</li>`).join('');
  const peerPermission = scopes.some(scope => scope.startsWith('peers.'))
    ? '<label><input type="checkbox" name="allow_peers" value="yes"> Allow this app to use my existing permitted peer connections</label>' : '';
  const hostedPermission = wantsMessages ? '<label><input type="checkbox" name="allow_hosted" value="yes" checked> Keep working after I close the browser. I approve ChatMCP retaining a protected copy of my encryption key to process the approved agent messages and files. This account key can cryptographically unlock my account; API access remains restricted to the approved agent. Disconnect revokes access and removes the stored key.</label>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to ChatMCP</title><style>body{font:16px system-ui;background:#111827;color:#e5e7eb;margin:0;padding:2rem}.card{max-width:38rem;margin:5vh auto;background:#1f2937;border:1px solid #374151;border-radius:1rem;padding:2rem}button{padding:.75rem 1rem;border:0;border-radius:.5rem;background:#059669;color:white;font-weight:700;cursor:pointer}a{color:#6ee7b7}.muted{color:#9ca3af}label{display:block;margin:1rem 0}select{padding:.6rem;max-width:100%}</style></head><body><main class="card"><h1>Connect ${escape(clientName)} to ChatMCP</h1><p>Approve access for this app:</p><ul>${permissions}</ul>${wantsMessages ? `<p><strong>Message access disclosure:</strong> ChatMCP and the connected AI app will process message text. The connected AI app and ChatMCP process approved message and file contents. Always-on mode securely retains the encryption key after a one-time unlock; browser-only mode keeps the key in your browser. Stored messages and files remain encrypted. This connector is not end-to-end encrypted between you and the AI app.</p><label>Agent identity<br><select name="agent_id" form="consent-form"><option value="">Create a dedicated ${escape(clientName)} MCP agent</option>${choices}</select></label>${scopes.some(scope => scope.startsWith('peers.')) ? '<p>Peer access follows your existing peer and group permissions. Shared peers may require separate shared-key setup.</p>' : ''}` : '<p class="muted">This is the existing read-only agent catalogue permission. It does not gain message access.</p>'}<form id="consent-form" method="post" action="/oauth/authorize/consent"><input type="hidden" name="_csrf" value="${escape(csrfToken)}"><input type="hidden" name="authorize_id" value="${escape(authorizeId)}">${peerPermission}${hostedPermission}<button name="decision" value="allow">Approve</button> <button name="decision" value="deny" formnovalidate>Cancel</button></form><p class="muted"><a href="/privacy">Privacy policy</a></p></main></body></html>`;
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
  if (completed.connectionUrl) return res.redirect(303, completed.connectionUrl);
  const nonce = res.locals.cspNonce;
  const script = nonce && !completed.connectionUrl
    ? `<script nonce="${escapeHtml(nonce)}">window.location.replace(${safeJsonForScript(completed.callbackUrl)});</script>`
    : '';
  const connectionLink = completed.connectionUrl
    ? `<p><a target="_blank" rel="noopener noreferrer" href="${escapeHtml(completed.connectionUrl)}">Open the ChatMCP message connection in a new tab</a>. Keep that tab open and return to your AI app.</p>`
    : '';
  return res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).type('html')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Returning to your app</title></head><body><h1>Approval saved</h1>${connectionLink}<p><a href="${escapeHtml(completed.callbackUrl)}">Continue to connected app</a></p>${script}</body></html>`);
});

router.get('/oauth/authorize/consent', (_req, res) => consentUnavailable(res));

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = getBaseUrl(req);
  res.set('Cache-Control', 'public, max-age=300').json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [...SUPPORTED_SCOPES],
    resource_documentation: `${base}/mcp-guide`
  });
});
router.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  const base = getBaseUrl(req);
  res.set('Cache-Control', 'public, max-age=300').json({
    resource: `${base}/mcp`, authorization_servers: [base],
    bearer_methods_supported: ['header'], scopes_supported: [...SUPPORTED_SCOPES],
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
    scopes_supported: [...SUPPORTED_SCOPES]
  });
});

router.get('/mcp-guide', (req, res) => {
  const endpoint = `${getBaseUrl(req)}/mcp`;
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Gemini to ChatMCP</title><style>body{font:16px system-ui;max-width:48rem;margin:3rem auto;padding:0 1.25rem;background:#0f172a;color:#e2e8f0}code{background:#1e293b;padding:.2rem .4rem;border-radius:.3rem}a{color:#6ee7b7}</style></head><body><h1>Connect Gemini to ChatMCP</h1><ol><li>In Gemini, choose <strong>Connect to an MCP server</strong>.</li><li>Enter this MCP server URL: <code>${escapeHtml(endpoint)}</code></li><li>Continue to ChatMCP, sign in, and approve the requested agent and message permissions.</li><li>Leave always-on access selected, unlock once, then return to Gemini. After activation you can close the ChatMCP tab.</li></ol><p>Always-on message and file tools work without an open browser after one-time approval. ChatMCP retains a protected copy of the approved encryption key and processes message and attachment contents for the connected AI. Stored messages and files remain encrypted; this connector is not end-to-end encrypted to the AI app. Files of any type use the configured attachment size limit. Shared peers need their separate key configured once. The AI app controls when tools run and whether it wakes in the background.</p><p>Legacy <code>agents.read</code> grants still provide only the agent catalogue. You can disconnect a message grant from its ChatMCP connection page.</p><p><a href="/settings">Account settings</a></p></body></html>`);
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
  const requestedScopes = [...new Set(String(req.query.scope || DEFAULT_REQUESTED_SCOPES.join(' ')).split(/\s+/).filter(Boolean))];
  if (typeof state !== 'string' || !state.length || state.length > MAX_OAUTH_STATE_LENGTH) {
    return oauthError(res, 400, 'invalid_request', `state must be a non-empty string of at most ${MAX_OAUTH_STATE_LENGTH} characters.`);
  }
  if (responseType !== 'code' || !clientId || !redirectUri ||
      !codeChallenge || method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(codeChallenge)) ||
      resource !== `${base}/mcp` || !requestedScopes.length || requestedScopes.some(scope => !SUPPORTED_SCOPES.has(scope)) ||
      (requestedScopes.some(scope => scope.startsWith('peers.')) && !requestedScopes.includes('messages.read')) ||
      (requestedScopes.includes('peers.write') && !requestedScopes.includes('peers.read'))) {
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
    let eligibleAgents = [];
    if (requestedScopes.some(scope => MESSAGE_SCOPES.includes(scope))) {
      const available = await query(`SELECT a.agent_id, a.agent_name,
          COALESCE(a.last_seen_at < NOW()::timestamp - INTERVAL '5 minutes', TRUE) AS eligible
        FROM agents a WHERE a.user_id = $1
        ORDER BY a.position, a.agent_name LIMIT 100`, [req.session.userId]);
      eligibleAgents = available.rows;
    }
    req.session.mcpPendingAuthorization = {
      id: authorizeId, clientId, clientName: client.client_name, redirectUri,
      codeChallenge: String(codeChallenge), resource: `${base}/mcp`,
      scopes: requestedScopes, state: String(state), csrfToken, userId: req.session.userId,
      expiresAt: Date.now() + CODE_TTL_MS
    };
    return res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
      .type('html').send(safeConsentHtml({ clientName: client.client_name, scopes: requestedScopes, agents: eligibleAgents, csrfToken, authorizeId }));
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
    let grantedScopes = [...pending.scopes];
    if (req.body.allow_peers !== 'yes') grantedScopes = grantedScopes.filter(scope => !scope.startsWith('peers.'));
    let boundAgentId = null;
    if (grantedScopes.some(scope => MESSAGE_SCOPES.includes(scope))) {
      boundAgentId = typeof req.body.agent_id === 'string' && req.body.agent_id ? req.body.agent_id : null;
      if (boundAgentId) {
        const selected = await query(`SELECT agent_id FROM agents
          WHERE agent_id = $1 AND user_id = $2
            AND (last_seen_at IS NULL OR last_seen_at < NOW()::timestamp - INTERVAL '5 minutes')`, [boundAgentId, pending.userId]);
        if (!selected.rows.length) return res.status(400).type('text').send('That agent is active or unavailable. Choose an idle agent or create a dedicated MCP agent.');
      } else {
        const requestedName = String(pending.clientName || 'MCP').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 220) || 'MCP';
        const baseName = `${requestedName} MCP`;
        const client = await getClient();
        try {
          await client.query('BEGIN');
          let candidate = baseName;
          for (let suffix = 2; suffix < 100; suffix++) {
            const exists = await client.query('SELECT 1 FROM agents WHERE user_id=$1 AND agent_name=$2', [pending.userId, candidate]);
            if (!exists.rows.length) break;
            candidate = `${baseName.slice(0, 255 - String(suffix).length - 3)} (${suffix})`;
          }
          const interAgentMode = grantedScopes.includes('peers.read') ? 'listen_all' : 'disabled';
          const inserted = await client.query(`INSERT INTO agents(user_id,agent_name,agent_type,position,can_spawn,inter_agent_mode)
            VALUES($1,$2,'standard',COALESCE((SELECT MAX(position)+1 FROM agents WHERE user_id=$1),1),FALSE,$3) RETURNING agent_id`, [pending.userId, candidate, interAgentMode]);
          boundAgentId = inserted.rows[0].agent_id;
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally { client.release(); }
      }
    }
    const grantId = boundAgentId ? crypto.randomUUID() : null;
    const grantedScope = grantedScopes.join(' ');
    await query(`INSERT INTO mcp_oauth_codes
      (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, expires_at, grant_id, agent_id, hosted_approved)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [sha256(code), pending.clientId, req.session.userId, pending.redirectUri, pending.codeChallenge, pending.resource, grantedScope, new Date(Date.now() + CODE_TTL_MS), grantId, boundAgentId, !!boundAgentId && req.body.allow_hosted === 'yes']);
    callback.searchParams.set('code', code);
    delete req.session.mcpPendingAuthorization;
    return finishConsent(req, res, { ...completed, callbackUrl: callback.toString(), connectionUrl: boundAgentId ? `/mcp/connection?grant_id=${encodeURIComponent(grantId)}` : null });
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
          RETURNING user_id, client_id, resource, scope, grant_id, agent_id, hosted_approved`,
        [sha256(code), clientId, redirectUri, resource, challenge, now, now]);
        identity = consumed.rows[0];
        if (!identity) {
          await client.query('ROLLBACK');
          return oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used.');
        }
        await client.query(`INSERT INTO mcp_oauth_tokens
          (access_token_hash, refresh_token_hash, client_id, user_id, resource, scope, expires_at, refresh_expires_at, grant_id, agent_id, hosted_approved)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [sha256(accessToken), sha256(nextRefreshToken), identity.client_id, identity.user_id, identity.resource, identity.scope,
          new Date(Date.now() + ACCESS_TTL_SECONDS * 1000), new Date(Date.now() + REFRESH_TTL_MS), identity.grant_id, identity.agent_id, identity.hosted_approved]);
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
        RETURNING user_id, client_id, resource, scope, grant_id, agent_id, hosted_approved`,
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
    let revokedGrants = [];
    if (!hint || hint === 'access_token') {
      const revoked = await query('UPDATE mcp_oauth_tokens SET revoked_at = $3 WHERE access_token_hash = $1 AND client_id = $2 RETURNING grant_id', [tokenHash, clientId, revokedAt]);
      revokedGrants = revokedGrants.concat(revoked.rows.map(row => row.grant_id));
    }
    if (!hint || hint === 'refresh_token') {
      const revoked = await query('UPDATE mcp_oauth_tokens SET revoked_at = $3 WHERE refresh_token_hash = $1 AND client_id = $2 RETURNING grant_id', [tokenHash, clientId, revokedAt]);
      revokedGrants = revokedGrants.concat(revoked.rows.map(row => row.grant_id));
    }
    for (const grantId of new Set(revokedGrants.filter(Boolean))) {
      await query('UPDATE agent_api_credentials SET revoked_at = NOW()::timestamp WHERE mcp_grant_id = $1 AND revoked_at IS NULL', [grantId]);
      messageBroker.revokeGrant(grantId);
      await hostedMcp.revoke(grantId);
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
    res.set('WWW-Authenticate', `Bearer resource_metadata="${getBaseUrl(req)}/.well-known/oauth-protected-resource", scope="${AUTH_SCOPE_HINT}"`);
    return res.status(401).json({ error: 'invalid_token', error_description: 'A valid bearer token is required.' });
  }
  try {
    const now = new Date();
    const result = await query(`SELECT user_id, resource, scope, grant_id, agent_id, hosted_approved FROM mcp_oauth_tokens
      WHERE access_token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`, [sha256(match[1]), now]);
    const token = result.rows[0];
    if (!token || token.resource !== `${getBaseUrl(req)}/mcp`) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${getBaseUrl(req)}/.well-known/oauth-protected-resource", scope="${AUTH_SCOPE_HINT}", error="invalid_token"`);
      return res.status(401).json({ error: 'invalid_token', error_description: 'The access token is invalid or expired.' });
    }
    const grantedScopes = token.scope.split(/\s+/).filter(Boolean);
    if (!grantedScopes.some(scope => SUPPORTED_SCOPES.has(scope))) return res.status(403).json({ error: 'insufficient_scope' });
    req.mcpUserId = token.user_id;
    req.mcpScopes = grantedScopes;
    req.mcpGrantId = token.grant_id;
    req.mcpAgentId = token.agent_id;
    req.mcpHostedApproved = token.hosted_approved === true;
    return next();
  } catch (error) {
    console.error('MCP token validation failed:', error.message);
    return res.status(500).json({ error: 'server_error' });
  }
}

function requireBrowserSession(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'login_required' });
  return next();
}
function requireConnectionPageSession(req, res, next) {
  if (req.session?.userId) return next();
  const grantId = req.query.grant_id;
  if (typeof grantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(grantId)) return res.status(404).type('text').send('Message grant not found. Return to your AI app and reconnect.');
  req.session.mcpOAuthReturnTo = `/mcp/connection?grant_id=${encodeURIComponent(grantId)}`;
  req.session.mcpOAuthReturnToExpiresAt = Date.now() + 15 * 60 * 1000;
  return res.redirect(302, '/login');
}
function validSameOrigin(req) {
  const base = getBaseUrl(req);
  const origin = req.get('origin');
  const referer = req.get('referer');
  try {
    return (!origin || origin === new URL(base).origin) && (!referer || new URL(referer).origin === new URL(base).origin);
  } catch (_error) { return false; }
}
async function lookupMessageGrant(grantId, ownerId) {
  if (typeof grantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(grantId)) return null;
  const result = await query(`SELECT grant_id, agent_id, scope, hosted_approved FROM mcp_oauth_tokens
    WHERE grant_id=$1 AND user_id=$2 AND revoked_at IS NULL AND refresh_expires_at > NOW() LIMIT 1`, [grantId, ownerId]);
  return result.rows[0] || null;
}
async function lookupConnectionGrant(grantId, ownerId) {
  const active = await lookupMessageGrant(grantId, ownerId);
  if (active) return { ...active, ready: true };
  if (typeof grantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(grantId)) return null;
  const pending = await query(`SELECT grant_id, agent_id, scope, hosted_approved FROM mcp_oauth_codes
    WHERE grant_id=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at > NOW() LIMIT 1`, [grantId, ownerId]);
  return pending.rows[0] ? { ...pending.rows[0], ready: false } : null;
}

router.get('/mcp/connection', requireConnectionPageSession, async (req, res) => {
  if (!validSameOrigin(req)) return res.status(403).type('text').send('Origin not allowed.');
  const grant = await lookupConnectionGrant(req.query.grant_id, req.session.userId);
  if (!grant || !grant.agent_id || !grant.scope.split(/\s+/).some(scope => MESSAGE_SCOPES.includes(scope))) return res.status(404).type('text').send('Message grant not found. Return to your AI app and reconnect.');
  const agent = await query('SELECT agent_name FROM agents WHERE agent_id=$1 AND user_id=$2', [grant.agent_id, req.session.userId]);
  if (!agent.rows[0]) return res.status(404).type('text').send('Approved agent is unavailable. Reconnect and approve again.');
  const user = await query('SELECT encryption_salt FROM users WHERE user_id=$1', [req.session.userId]);
  if (!user.rows[0]?.encryption_salt) return res.status(409).type('text').send('Encryption setup is incomplete. Finish encryption setup in ChatMCP before connecting message tools.');
  if (!req.session.mcpGatewayCsrf) req.session.mcpGatewayCsrf = randomToken();
  const csrf = escapeHtml(req.session.mcpGatewayCsrf);
  const grantId = escapeHtml(grant.grant_id);
  const rawAgentName = agent.rows[0].agent_name;
  const agentName = escapeHtml(rawAgentName);
  const completed = req.session.mcpCompletedAuthorization;
  const callbackLink = completed?.connectionUrl === `/mcp/connection?grant_id=${encodeURIComponent(grant.grant_id)}` &&
    completed.userId === req.session.userId && Date.now() <= completed.expiresAt
    ? `<a id="returnToApp" class="button primary" target="_blank" rel="noopener noreferrer" href="${escapeHtml(completed.callbackUrl)}">Return to your AI app <span aria-hidden="true">↗</span></a>`
    : '<p>Switch back to the AI app where you added ChatMCP. If that connection has expired, start a new connection there.</p>';
  const nonce = res.locals.cspNonce;
  const scripts = `<script src="/js/encryption.js?v=mcp-connect-20261025-2"></script><script src="/js/mcpConnection.js?v=mcp-connect-20261025-2"${nonce ? ` nonce="${escapeHtml(nonce)}"` : ''}></script>`;
  return res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your agent · ChatMCP</title><link rel="stylesheet" href="/css/mcp-connection.css?v=mcp-connect-20261025-2"></head>
<body><main>
  <header><p class="eyebrow">ChatMCP · Agent setup</p><h1>Finish connecting your agent</h1>
    <p class="intro">Your approval is saved. Unlock your chats, then finish the connection in your AI app.</p>
    <p class="agent">Approved agent <strong>${agentName}</strong><span>${grant.hosted_approved ? 'Always-on access' : 'Browser-only access'}</span></p>
  </header>
  <ol class="steps" aria-label="Connection progress">
    <li data-done="true"><span class="step-number" aria-hidden="true">✓</span><span><strong>1. Approve access</strong><small>Done</small></span></li>
    <li id="unlockStep"><span class="step-number" aria-hidden="true">2</span><span><strong>Unlock your chats</strong><small>Use your encryption password</small></span></li>
    <li id="appStep"><span class="step-number" aria-hidden="true">3</span><span><strong>Finish in your AI app</strong><small>Wait for Connected below</small></span></li>
  </ol>
  <section id="connectionStatus" class="status" role="status" aria-live="polite" aria-atomic="true">
    <h2 id="state">Checking connection</h2><p id="detail">Looking for an encryption key saved in this browser…</p>
  </section>
  <section id="unlock" class="action-panel" hidden aria-labelledby="unlockTitle">
    <h2 id="unlockTitle">Unlock your chats</h2>
    <p>Enter the encryption password you use to read chats in ChatMCP. The password stays in this browser.</p>
    <label for="password">Encryption password</label>
    <input id="password" type="password" autocomplete="current-password" aria-describedby="detail" required>
    <button id="unlockButton" class="primary" type="button">${grant.hosted_approved ? 'Unlock and enable connection' : 'Unlock and connect'}</button>
  </section>
  <section class="action-panel" aria-labelledby="returnTitle">
    <h2 id="returnTitle">Finish in your AI app</h2>
    <p id="returnInstruction">Use the button below and complete any remaining Connect or Continue prompt in your AI app.
    Keep this page open until the status says <strong>Connected</strong>.</p>
    ${callbackLink}<p id="returnFeedback" role="status"></p>
    <p id="successActions" class="success-note" hidden>${grant.hosted_approved ? 'Setup complete. You can close this tab.' : 'Setup complete. Keep this tab open and unlocked for browser-only access.'} Ask your AI app to read your ChatMCP inbox or send a test message.</p>
  </section>
  <div class="recovery"><button id="reconnect" type="button">Try connecting again</button><button id="changeKey" type="button" hidden>Use another encryption password</button></div>
  <details><summary>How this connection works</summary><p>${grant.hosted_approved ? 'You approved always-on access. ChatMCP stores a protected copy of your encryption key and processes approved messages and files on the server. Once connected, this tab can close.' : 'You selected browser-only access. The key stays in this browser and this tab must remain open and unlocked.'} Stored messages remain encrypted. This connector is not end-to-end encrypted to the AI app. Your AI app decides when to use tools and whether it can wake in the background.</p></details>
  <footer><nav aria-label="Connection help"><a href="/mcp-guide">Connection help</a><a href="/settings">Account settings</a></nav><button id="disconnect" class="danger" type="button">Disconnect and revoke access</button></footer>
  <noscript><p class="status">JavaScript is required to unlock and connect. Enable it for ChatMCP, then reload this page.</p></noscript>
</main><script id="mcp-config" type="application/json">${safeJsonForScript({ grantId, agentName: rawAgentName, csrf, grantReady: grant.ready, hostedApproved: grant.hosted_approved === true, peerAccess: grant.scope.split(/\s+/).includes('peers.read'), encryptionSalt: user.rows[0].encryption_salt })}</script>${scripts}</body></html>`);
});

async function validateGatewayRequest(req, res) {
  if (!validSameOrigin(req)) { res.status(403).json({ error: 'origin_not_allowed' }); return null; }
  if (!req.session?.mcpGatewayCsrf || req.get('x-csrf-token') !== req.session.mcpGatewayCsrf) { res.status(403).json({ error: 'csrf_invalid' }); return null; }
  const grant = await lookupMessageGrant(req.body?.grantId || req.query?.grantId, req.session.userId);
  if (!grant) { res.status(401).json({ error: 'grant_revoked' }); return null; }
  return grant;
}

router.post('/mcp/hosted/enable', requireBrowserSession, async (req, res) => {
  try {
    if (!validSameOrigin(req)) return res.status(403).json({ error: 'origin_not_allowed' });
    if (!req.session?.mcpGatewayCsrf || req.get('x-csrf-token') !== req.session.mcpGatewayCsrf) return res.status(403).json({ error: 'csrf_invalid' });
    const grant = await lookupConnectionGrant(req.body?.grantId || req.query?.grantId, req.session.userId);
    if (!grant) return res.status(401).json({ error: 'grant_revoked' });
    if (!grant.hosted_approved) return res.status(403).json({ error: 'hosted_approval_required' });
    const result = await hostedMcp.enable(grant.grant_id, req.session.userId, req.body.encryptionKey);
    messageBroker.revokeGrant(grant.grant_id);
    await query('UPDATE agent_api_credentials SET revoked_at=NOW() WHERE mcp_grant_id=$1 AND revoked_at IS NULL', [grant.grant_id]);
    if (!grant.ready) {
      return res.set('Cache-Control', 'no-store').status(401).json({ error: 'grant_revoked', keyStored: true });
    }
    return res.set('Cache-Control', 'no-store').json(result);
  } catch (_error) {
    // Never include submitted key material or cryptographic exceptions in logs.
    return res.status(503).json({ error: 'hosted_setup_failed', message: 'Always-on setup failed. Check the encryption password and the service key-storage configuration, then retry.' });
  }
});
router.post('/mcp/hosted/peers', requireBrowserSession, async (req, res) => {
  try {
    const grant = await validateGatewayRequest(req, res);
    if (!grant) return;
    if (!grant.scope.split(/\s+/).includes('peers.read')) return res.status(403).json({ error: 'peer_scope_required' });
    const result = await hostedMcp.execute({ grantId: grant.grant_id, ownerId: req.session.userId, origin: getBaseUrl(req) }, 'list_agents', {});
    return res.set('Cache-Control', 'no-store').json(result);
  } catch (_error) { return res.status(503).json({ error: 'peer_setup_unavailable' }); }
});
router.post('/mcp/hosted/peer-key', requireBrowserSession, async (req, res) => {
  try {
    const grant = await validateGatewayRequest(req, res);
    if (!grant) return;
    const result = await hostedMcp.configurePeer({ grantId: grant.grant_id, ownerId: req.session.userId, origin: getBaseUrl(req) }, req.body.peerId, req.body.encryptionKey);
    return res.set('Cache-Control', 'no-store').json(result);
  } catch (_error) { return res.status(403).json({ error: 'peer_key_not_approved', message: 'Check that this peer is still permitted and enter its shared encryption password and salt.' }); }
});

router.post('/mcp/gateway/enroll', requireBrowserSession, async (req, res) => {
  let authorizedGrantId = null;
  try {
    const grant = await validateGatewayRequest(req, res);
    if (!grant) return;
    authorizedGrantId = grant.grant_id;
    if (!grant.agent_id || !grant.scope.split(/\s+/).some(scope => ['messages.read', 'messages.write'].includes(scope))) return res.status(403).json({ error: 'message_scope_required' });
    await query('UPDATE agent_api_credentials SET revoked_at=NOW()::timestamp WHERE mcp_grant_id=$1 AND revoked_at IS NULL', [grant.grant_id]);
    const granted = grant.scope.split(/\s+/);
    const scopes = [];
    if (granted.includes('messages.read')) scopes.push('agent.history.read', 'agent.responses.read');
    if (granted.includes('messages.write')) scopes.push('agent.messages.write');
    if (granted.includes('peers.read')) scopes.push('agent.dm.read', 'agent.discover.read');
    if (granted.includes('peers.write')) scopes.push('agent.dm.write');
    const credential = await issueScopedCredential({ agentId: grant.agent_id, scopes, expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000), mcpGrantId: grant.grant_id });
    const connection = messageBroker.enroll({ ownerId: req.session.userId, grantId: grant.grant_id, sessionId: req.sessionID });
    return res.set('Cache-Control', 'no-store').json({ ...connection, agentName: (await query('SELECT agent_name FROM agents WHERE agent_id=$1', [grant.agent_id])).rows[0]?.agent_name, agentToken: credential.token, encryptionSalt: (await query('SELECT encryption_salt FROM users WHERE user_id=$1', [req.session.userId])).rows[0]?.encryption_salt });
  } catch (error) {
    if (authorizedGrantId) {
      await query('UPDATE agent_api_credentials SET revoked_at=NOW()::timestamp WHERE mcp_grant_id=$1 AND revoked_at IS NULL', [authorizedGrantId]).catch(() => {});
      messageBroker.revokeGrant(authorizedGrantId);
    }
    console.error('MCP gateway enrollment failed:', error.message);
    return res.status(503).json({ error: 'gateway_unavailable' });
  }
});
router.post('/mcp/gateway/claim', requireBrowserSession, async (req, res) => {
  try {
    const grant = await validateGatewayRequest(req, res);
    if (!grant) return;
    if (messageBroker.connectionGrantId({ connectionId: req.body.connectionId, gatewaySecret: req.body.gatewaySecret, ownerId: req.session.userId, sessionId: req.sessionID }) !== grant.grant_id) return res.status(403).json({ error: 'gateway_grant_mismatch' });
    const item = messageBroker.claim({ connectionId: req.body.connectionId, gatewaySecret: req.body.gatewaySecret, ownerId: req.session.userId, sessionId: req.sessionID });
    return res.set('Cache-Control', 'no-store').json({ operation: item });
  } catch (_error) { return res.status(503).json({ error: 'gateway_unavailable' }); }
});
router.post('/mcp/gateway/result', requireBrowserSession, async (req, res) => {
  try {
    const grant = await validateGatewayRequest(req, res);
    if (!grant) return;
    if (messageBroker.connectionGrantId({ connectionId: req.body.connectionId, gatewaySecret: req.body.gatewaySecret, ownerId: req.session.userId, sessionId: req.sessionID }) !== grant.grant_id) return res.status(403).json({ error: 'gateway_grant_mismatch' });
    if (req.body?.result && byteLength(req.body.result) > 256 * 1024) return res.status(413).json({ error: 'result_too_large' });
    const accepted = messageBroker.complete({ connectionId: req.body.connectionId, gatewaySecret: req.body.gatewaySecret, ownerId: req.session.userId, sessionId: req.sessionID, requestId: req.body.requestId, result: req.body.result, error: req.body.error });
    return res.set('Cache-Control', 'no-store').json({ accepted });
  } catch (_error) { return res.status(503).json({ error: 'gateway_unavailable' }); }
});
router.post('/mcp/gateway/close', requireBrowserSession, async (req, res) => {
  try {
    const grant = await validateGatewayRequest(req, res);
    if (!grant) return;
    let closed = false;
    if (req.body.connectionId) {
      if (messageBroker.connectionGrantId({ connectionId: req.body.connectionId, gatewaySecret: req.body.gatewaySecret, ownerId: req.session.userId, sessionId: req.sessionID }) === grant.grant_id) {
        closed = messageBroker.disconnect({ connectionId: req.body.connectionId, gatewaySecret: req.body.gatewaySecret, ownerId: req.session.userId, sessionId: req.sessionID });
      }
    }
    await query('UPDATE agent_api_credentials SET revoked_at=NOW()::timestamp WHERE mcp_grant_id=$1 AND revoked_at IS NULL', [grant.grant_id]);
    await hostedMcp.revoke(grant.grant_id);
    await query('UPDATE mcp_oauth_tokens SET revoked_at=NOW() WHERE grant_id=$1 AND revoked_at IS NULL', [grant.grant_id]);
    messageBroker.revokeGrant(grant.grant_id);
    return res.json({ closed });
  } catch (_error) { return res.status(503).json({ error: 'gateway_unavailable' }); }
});
router.get('/mcp/gateway/status', requireBrowserSession, async (req, res) => {
  try {
    const grant = await lookupMessageGrant(req.query.grantId, req.session.userId);
    if (!grant || !req.session.mcpGatewayCsrf || req.get('x-csrf-token') !== req.session.mcpGatewayCsrf || !validSameOrigin(req)) return res.status(401).json({ state: 'offline' });
    if (messageBroker.connectionGrantId({ connectionId: req.query.connectionId, gatewaySecret: req.get('x-gateway-secret'), ownerId: req.session.userId, sessionId: req.sessionID }) !== grant.grant_id) return res.json({ state: 'offline' });
    return res.set('Cache-Control', 'no-store').json(messageBroker.status({ connectionId: req.query.connectionId, gatewaySecret: req.get('x-gateway-secret'), ownerId: req.session.userId, sessionId: req.sessionID }));
  } catch (_error) { return res.status(503).json({ state: 'offline' }); }
});

const MCP_TOOL_SCHEMAS = {
  list_agents: { type: 'object', properties: {}, additionalProperties: false },
  get_connection_status: { type: 'object', properties: {}, additionalProperties: false },
  read_inbox: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  read_thread: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, beforeId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
  send_message: { type: 'object', required: ['idempotencyId'], properties: { text: { type: 'string', maxLength: 16000 }, attachmentIds: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', format: 'uuid' } }, idempotencyId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
  send_peer_message: { type: 'object', required: ['peerId', 'idempotencyId'], properties: { peerId: { type: 'string', format: 'uuid' }, text: { type: 'string', maxLength: 16000 }, attachmentIds: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', format: 'uuid' } }, idempotencyId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
  upload_attachment: { type: 'object', required: ['fileName', 'contentType', 'dataBase64', 'idempotencyId'], properties: { fileName: { type: 'string', minLength: 1, maxLength: 200 }, contentType: { type: 'string', maxLength: 255 }, dataBase64: { type: 'string', maxLength: Math.ceil(hostedMcp.MAX_FILE_BYTES / 3) * 4 }, idempotencyId: { type: 'string', format: 'uuid' }, peerId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
  read_attachment: { type: 'object', required: ['attachmentId'], properties: { attachmentId: { type: 'string', format: 'uuid' }, offset: { type: 'integer', minimum: 0, maximum: hostedMcp.MAX_FILE_BYTES }, length: { type: 'integer', minimum: 1, maximum: hostedMcp.MAX_CHUNK_BYTES } }, additionalProperties: false },
  ack_message: { type: 'object', required: ['messageId', 'kind'], properties: { messageId: { type: 'string', format: 'uuid' }, kind: { type: 'string', enum: ['user', 'response', 'peer'] } }, additionalProperties: false }
};
const MCP_TOOL_SCOPE = {
  list_agents: ['agents.read', 'messages.read'],
  get_connection_status: [], read_inbox: ['messages.read'], read_thread: ['messages.read'],
  send_message: ['messages.write'], send_peer_message: ['peers.write'], ack_message: ['messages.read'],
  upload_attachment: ['attachments.write'], read_attachment: ['attachments.read']
};
function toolsForScopes(scopes) {
  return Object.keys(MCP_TOOL_SCHEMAS).filter(name => {
    const required = MCP_TOOL_SCOPE[name];
    if (!required.length) return true;
    return required.some(scope => scopes.includes(scope));
  }).map(name => ({
    name,
    description: {
      list_agents: 'List owned agent names (agents.read) or peers currently permitted for the bound agent.',
      get_connection_status: 'Report the approved identity, always-on or browser connection state, and granted capabilities.',
      read_inbox: 'Read bounded unread user messages and, when peer access is approved, permitted peer messages without acknowledging them.',
      read_thread: 'Read visible agent history including attachment metadata and MCP resource URIs.',
      send_message: 'Send encrypted text to the user from the bound agent. Supply a stable UUID idempotencyId for safe retries.',
      send_peer_message: 'Send encrypted text to an explicitly permitted peer ID. Shared-key setup may be required.',
      ack_message: 'Acknowledge a successfully handled user or permitted peer inbox message.',
      upload_attachment: 'Upload any file type as base64 within the account attachment limit. Returns an attachmentId to include in send_message or send_peer_message. Requires always-on setup; use a stable UUID for retries.',
      read_attachment: 'Read decrypted file bytes, including images, PDFs, audio, video, and documents. Large files are read in bounded chunks using nextOffset. Requires attachment permission and always-on setup.'
    }[name], inputSchema: MCP_TOOL_SCHEMAS[name], annotations: { readOnlyHint: ['list_agents', 'get_connection_status', 'read_inbox', 'read_thread', 'read_attachment'].includes(name), openWorldHint: false }
  }));
}
function validArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const allowed = Object.keys(MCP_TOOL_SCHEMAS[name]?.properties || {});
  if (Object.keys(args).some(key => !allowed.includes(key))) return false;
  for (const key of ['limit']) if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < 1 || args[key] > 100)) return false;
  for (const key of ['text']) if (args[key] !== undefined && (typeof args[key] !== 'string' || Buffer.byteLength(args[key], 'utf8') > 16_000)) return false;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  for (const key of ['idempotencyId', 'messageId', 'peerId', 'attachmentId', 'beforeId']) if (args[key] !== undefined && !uuid(args[key])) return false;
  if (args.attachmentIds !== undefined && (!Array.isArray(args.attachmentIds) || args.attachmentIds.length > 10 || args.attachmentIds.some(id => !uuid(id)) || new Set(args.attachmentIds).size !== args.attachmentIds.length)) return false;
  if (name === 'ack_message' && !['user', 'response', 'peer'].includes(args.kind)) return false;
  if (name === 'read_thread' && args.before !== undefined && (typeof args.before !== 'string' || args.before.length > 40 || Number.isNaN(Date.parse(args.before)))) return false;
  if (['send_message', 'send_peer_message'].includes(name) && (!args.idempotencyId || (!args.text?.trim() && !args.attachmentIds?.length))) return false;
  if (name === 'upload_attachment' && (!uuid(args.idempotencyId) || typeof args.fileName !== 'string' || !args.fileName.trim() || args.fileName.length > 200 || /[\x00-\x1f/\\]/.test(args.fileName) || typeof args.contentType !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(args.contentType) || typeof args.dataBase64 !== 'string' || args.dataBase64.length > Math.ceil(hostedMcp.MAX_FILE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.dataBase64))) return false;
  if (name === 'read_attachment' && (!uuid(args.attachmentId) || (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0 || args.offset > hostedMcp.MAX_FILE_BYTES)) || (args.length !== undefined && (!Number.isInteger(args.length) || args.length < 1 || args.length > hostedMcp.MAX_CHUNK_BYTES)))) return false;
  if (name === 'send_peer_message' && !args.peerId) return false;
  if (name === 'ack_message' && (!args.messageId || !args.kind)) return false;
  return true;
}
function toolTextResult(text, data, isError = false) {
  return { content: [{ type: 'text', text }], ...(data === undefined ? {} : { structuredContent: data }), isError };
}
async function executeMcpTool(req, name, args) {
  const scopes = req.mcpScopes || [];
  const required = MCP_TOOL_SCOPE[name] || [];
  if (!required.some(scope => scopes.includes(scope)) && required.length) {
    const missing = required.join(' ');
    return { denied: true, missing };
  }
  if (!validArgs(name, args)) return toolTextResult('Invalid arguments for this MCP tool.', undefined, true);
  if (name === 'get_connection_status') {
    // Legacy catalogue grants have no agent or gateway. Say so instead of
    // reporting a misleading "offline" gateway, so the app can reconnect.
    if (!req.mcpGrantId) {
      return toolTextResult('This is a read-only agent catalogue connection. It cannot read or send messages. Reconnect to ChatMCP and approve message access; if the app keeps this result after reconnecting, fully restart it so it loads the new login (Codex: codex mcp logout <server>, codex mcp login <server>, then start a new session).',
        { identity: null, mode: 'catalogue', gateway: 'not_applicable', messaging: false, reconnectRequired: true, capabilities: scopes });
    }
    const hosted = !!req.mcpGrantId && await hostedMcp.enabled(req.mcpGrantId, req.mcpUserId);
    const state = req.mcpHostedApproved ? await hostedMcp.readiness(req.mcpGrantId, req.mcpUserId) : messageBroker.statusForGrant({ ownerId: req.mcpUserId, grantId: req.mcpGrantId }).state;
    return toolTextResult('MCP connection status.', { identity: req.mcpAgentId || null, mode: req.mcpHostedApproved ? 'hosted' : 'browser', browserRequired: !hosted, browserRequiredAfterSetup: !req.mcpHostedApproved, setupRequired: req.mcpHostedApproved && state !== 'connected', gateway: state, capabilities: scopes,
      ...(state === 'connected' ? {} : { setupUrl: `${getBaseUrl(req)}/mcp/connection?grant_id=${encodeURIComponent(req.mcpGrantId)}` }) });
  }
  if (name === 'list_agents' && scopes.includes(SCOPE) && !req.mcpGrantId) {
    const result = await query('SELECT agent_id AS id, agent_name AS name FROM agents WHERE user_id=$1 ORDER BY position,agent_name LIMIT 100', [req.mcpUserId]);
    const agents = result.rows;
    return toolTextResult(JSON.stringify(agents), { agents });
  }
  if (!req.mcpGrantId || !req.mcpAgentId) return toolTextResult('This tool requires a message grant bound to an agent. Reconnect and approve an agent identity.', undefined, true);
  try {
    if (!await lookupMessageGrant(req.mcpGrantId, req.mcpUserId)) return toolTextResult('The MCP message grant has expired or was revoked. Reconnect and approve message access again.', undefined, true);
    if (name === 'list_agents' && !scopes.includes('peers.read')) {
      const own = await query('SELECT agent_id AS id, agent_name AS name FROM agents WHERE agent_id=$1 AND user_id=$2', [req.mcpAgentId, req.mcpUserId]);
      return toolTextResult(JSON.stringify(own.rows), { agents: own.rows });
    }
    if (name === 'ack_message' && args.kind === 'peer' && !scopes.includes('peers.read')) return { denied: true, missing: 'peers.read' };
    if (args.attachmentIds?.length && !scopes.includes('attachments.write')) return { denied: true, missing: 'attachments.write' };
    if (name === 'upload_attachment' && args.peerId && !scopes.includes('peers.write')) return { denied: true, missing: 'peers.write' };
    if (await hostedMcp.enabled(req.mcpGrantId, req.mcpUserId)) {
      const result = await hostedMcp.execute({ grantId: req.mcpGrantId, ownerId: req.mcpUserId, origin: getBaseUrl(req) }, name, args);
      const response = toolTextResult(JSON.stringify(result), result);
      if (name === 'read_attachment') {
        const uri = `${result.uri}?offset=${result.offset}&length=${args.length || hostedMcp.MAX_CHUNK_BYTES}`;
        response.content.push({ type: 'resource', resource: { uri, mimeType: result.nextOffset !== null || result.offset ? 'application/octet-stream' : result.mimeType, blob: result.dataBase64 } });
        if (result.offset === 0 && result.nextOffset === null && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(result.mimeType)) response.content.push({ type: 'image', mimeType: result.mimeType, data: result.dataBase64 });
      }
      return response;
    }
    if (req.mcpHostedApproved) return toolTextResult(`Finish the one-time encryption unlock at ${getBaseUrl(req)}/mcp/connection?grant_id=${encodeURIComponent(req.mcpGrantId)}. After activation the browser can close.`, { setupRequired: true, browserRequiredAfterSetup: false }, true);
    if (['upload_attachment', 'read_attachment'].includes(name) || args.attachmentIds?.length) return toolTextResult('Enable always-on access in the connection page to use file tools.', undefined, true);
    const result = await messageBroker.request({ ownerId: req.mcpUserId, grantId: req.mcpGrantId, operation: name, args: { ...args, peerRead: scopes.includes('peers.read'), agentId: req.mcpAgentId } });
    const active = await lookupMessageGrant(req.mcpGrantId, req.mcpUserId);
    if (!active) return toolTextResult('The MCP message grant was revoked while this request was running.', undefined, true);
    if (name === 'list_agents') return toolTextResult(JSON.stringify(result), { agents: result });
    return toolTextResult(JSON.stringify(result), Array.isArray(result) ? { messages: result } : result);
  } catch (error) {
    const reconnect = `${getBaseUrl(req)}/mcp/connection?grant_id=${encodeURIComponent(req.mcpGrantId)}`;
    return toolTextResult(`${error.message} Reconnect at ${reconnect}`, undefined, true);
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
      capabilities: { tools: { listChanged: false }, resources: {} },
      serverInfo: { name: 'ChatMCP.Space', version: '1.0.0' }
    }));
  }
  if (body.method === 'ping') return res.type('application/json').json(jsonRpcResult(body.id, {}));
  if (body.method === 'tools/list') {
    return res.type('application/json').json(jsonRpcResult(body.id, { tools: toolsForScopes(req.mcpScopes || []) }));
  }
  if (body.method === 'tools/call') {
    const name = body.params?.name;
    if (!Object.hasOwn(MCP_TOOL_SCHEMAS, name)) return res.type('application/json').json(jsonRpcError(body.id, -32602, 'Unknown tool'));
    if (!body.params?.arguments && body.params?.arguments !== undefined) return res.type('application/json').json(jsonRpcError(body.id, -32602, 'Tool arguments must be an object'));
    const args = body.params?.arguments || {};
    try {
      const tool = await executeMcpTool(req, name, args);
      if (tool.denied) {
        res.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${tool.missing}"`);
        return res.status(403).type('application/json').json(jsonRpcError(body.id, -32003, `This tool requires OAuth scope: ${tool.missing}. Reconnect to approve it.`));
      }
      return res.type('application/json').json(jsonRpcResult(body.id, tool));
    } catch (error) {
      console.error('MCP tool request failed:', error.message);
      return res.type('application/json').json(jsonRpcResult(body.id, {
        content: [{ type: 'text', text: 'The MCP tool request could not be completed.' }], isError: true
      }));
    }
  }
  if (body.method === 'resources/read') {
    const match = /^chatmcp:\/\/attachments\/([0-9a-f-]{36})(?:\?offset=(\d+)&length=(\d+))?$/i.exec(body.params?.uri || '');
    if (!match) return res.json(jsonRpcError(body.id, -32602, 'Invalid attachment resource URI'));
    const args = { attachmentId: match[1], ...(match[2] ? { offset: Number(match[2]), length: Number(match[3]) } : {}) };
    try {
      const result = await executeMcpTool(req, 'read_attachment', args);
      if (result.denied) return res.status(403).set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${result.missing}"`).json(jsonRpcError(body.id, -32003, 'Attachment permission is required.'));
      if (result.isError) return res.json(jsonRpcError(body.id, -32002, result.content[0].text));
      return res.json(jsonRpcResult(body.id, { contents: [result.content.find(item => item.type === 'resource').resource] }));
    } catch (_error) { return res.json(jsonRpcError(body.id, -32002, 'Attachment could not be read.')); }
  }
  if (body.method === 'resources/templates/list') return res.json(jsonRpcResult(body.id, { resourceTemplates: [{ uriTemplate: 'chatmcp://attachments/{attachmentId}?offset={offset}&length={length}', name: 'Approved attachment bytes', description: 'Files visible to the bound agent, in bounded chunks.' }] }));
  if (body.method === 'resources/list') return res.type('application/json').json(jsonRpcResult(body.id, { resources: [] }));
  if (body.method === 'prompts/list') return res.type('application/json').json(jsonRpcResult(body.id, { prompts: [] }));
  return res.type('application/json').json(jsonRpcError(body.id, -32601, 'Method not found'));
});

router.get('/mcp', authenticateMcp, (req, res) => {
  res.set('Allow', 'POST').status(405).json({ error: 'Streamable HTTP requests must use POST.' });
});

module.exports = router;
module.exports._test = { isSafeRedirectUri, sha256 };
