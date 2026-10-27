const crypto = require('crypto');
const { query } = require('../db/connection');

function normalizeScopes(scopes) {
  if (Array.isArray(scopes)) {
    return scopes.filter(s => typeof s === 'string' && s.trim().length > 0);
  }
  if (scopes && typeof scopes === 'object') {
    return Object.entries(scopes)
      .filter(([, allowed]) => allowed === true)
      .map(([scope]) => scope);
  }
  return [];
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateAgentToken() {
  const randomPart = crypto.randomBytes(32).toString('base64url');
  return `agt_${randomPart}`;
}

function getTokenPrefix(rawToken) {
  return rawToken.slice(0, 16);
}

function toQueryRunner(client) {
  if (client && typeof client.query === 'function') {
    return (text, params) => client.query(text, params);
  }
  return (text, params) => query(text, params);
}

async function issueScopedCredential({ agentId, scopes = [], expiresAt = null, rotatedFrom = null, mcpGrantId = null, client = null }) {
  const run = toQueryRunner(client);
  const rawToken = generateAgentToken();
  const tokenHash = hashToken(rawToken);
  const tokenPrefix = getTokenPrefix(rawToken);
  const normalizedScopes = normalizeScopes(scopes);

  const result = await run(
    `INSERT INTO agent_api_credentials
      (agent_id, token_hash, token_prefix, scopes_json, expires_at, rotated_from, mcp_grant_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING credential_id, created_at`,
    [agentId, tokenHash, tokenPrefix, JSON.stringify(normalizedScopes), expiresAt, rotatedFrom, mcpGrantId]
  );

  return {
    credentialId: result.rows[0].credential_id,
    createdAt: result.rows[0].created_at,
    tokenPrefix,
    token: rawToken,
    scopes: normalizedScopes
  };
}

async function revokeActiveCredentials(agentId, { client = null } = {}) {
  const run = toQueryRunner(client);
  await run(
    'UPDATE agent_api_credentials SET revoked_at = NOW()::timestamp WHERE agent_id = $1 AND revoked_at IS NULL',
    [agentId]
  );
}

async function verifyScopedCredential(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length === 0) {
    return null;
  }

  const tokenHash = hashToken(rawToken.trim());
  const result = await query(
    `SELECT
      c.credential_id,
      c.agent_id,
      c.scopes_json,
      c.expires_at,
      c.revoked_at,
      c.mcp_grant_id,
      a.agent_name,
      a.user_id,
      u.email,
      u.api_key,
      u.encryption_salt
    FROM agent_api_credentials c
    JOIN agents a ON c.agent_id = a.agent_id
    JOIN users u ON a.user_id = u.user_id
    WHERE c.token_hash = $1
      AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR c.expires_at > NOW()::timestamp)
    LIMIT 1`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  if (row.mcp_grant_id) {
    const grant = await query(`SELECT 1 FROM mcp_oauth_tokens
      WHERE grant_id=$1 AND revoked_at IS NULL AND refresh_expires_at > NOW() LIMIT 1`, [row.mcp_grant_id]);
    if (!grant.rows.length) return null;
  }
  return {
    credentialId: row.credential_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    scopes: normalizeScopes(row.scopes_json),
    user: {
      userId: row.user_id,
      email: row.email,
      apiKey: row.api_key,
      encryptionSalt: row.encryption_salt
    }
  };
}

module.exports = {
  issueScopedCredential,
  revokeActiveCredentials,
  verifyScopedCredential,
  normalizeScopes,
  hashToken
};
