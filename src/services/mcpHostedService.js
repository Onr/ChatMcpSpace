const crypto = require('crypto');
const { query } = require('../db/connection');
const { issueScopedCredential } = require('./agentCredentialService');
const vault = require('./mcpKeyVault');

const MAX_FILE_BYTES = Number(process.env.MAX_ATTACHMENT_SIZE_MB || process.env.MAX_IMAGE_SIZE_MB || 20) * 1_000_000;
const MAX_CHUNK_BYTES = 256 * 1024;
const calls = new Map();
const FILE_SCOPE_READ = 'attachments.read';
const FILE_SCOPE_WRITE = 'attachments.write';
const peerId = peer => peer.agentId || peer.id;
const resourceUri = id => `chatmcp://attachments/${id}`;
const failure = message => new Error(message);

async function activeGrant(grantId, ownerId) {
  const result = await query(`SELECT t.grant_id, t.user_id, t.agent_id, t.scope, t.hosted_approved, a.agent_name
    FROM mcp_oauth_tokens t JOIN agents a ON a.agent_id=t.agent_id AND a.user_id=t.user_id
    WHERE t.grant_id=$1 AND t.user_id=$2 AND t.revoked_at IS NULL AND t.refresh_expires_at > NOW() LIMIT 1`, [grantId, ownerId]);
  return result.rows[0] || null;
}
async function connectionGrant(grantId, ownerId) {
  const active = await activeGrant(grantId, ownerId);
  if (active) return { ...active, ready: true };
  const pending = await query(`SELECT c.grant_id, c.user_id, c.agent_id, c.scope, c.hosted_approved, a.agent_name
    FROM mcp_oauth_codes c JOIN agents a ON a.agent_id=c.agent_id AND a.user_id=c.user_id
    WHERE c.grant_id=$1 AND c.user_id=$2 AND c.consumed_at IS NULL AND c.expires_at > NOW() LIMIT 1`, [grantId, ownerId]);
  return pending.rows[0] ? { ...pending.rows[0], ready: false } : null;
}
async function enabled(grantId, ownerId) {
  const grant = await activeGrant(grantId, ownerId);
  if (!grant?.hosted_approved) return false;
  const row = await query('SELECT sealed_key FROM mcp_hosted_connections WHERE grant_id=$1 AND user_id=$2 AND agent_id=$3', [grantId, ownerId, grant.agent_id]);
  return row.rows.length > 0;
}
async function readiness(grantId, ownerId) {
  const grant = await activeGrant(grantId, ownerId);
  if (!grant?.hosted_approved) return 'offline';
  const row = (await query('SELECT sealed_key FROM mcp_hosted_connections WHERE grant_id=$1 AND user_id=$2 AND agent_id=$3', [grantId, ownerId, grant.agent_id])).rows[0];
  if (!row) return 'needs_setup';
  try { const key = vault.unwrap(row.sealed_key, grant); key.fill(0); return 'connected'; }
  catch (_error) { return 'needs_setup'; }
}
async function enable(grantId, ownerId, encodedKey) {
  const grant = await connectionGrant(grantId, ownerId);
  if (!grant?.hosted_approved) throw failure('Always-on access requires explicit approval. Reconnect from your AI app and approve it.');
  if (typeof encodedKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) throw failure('A valid encryption key is required. Unlock in the connection page.');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) throw failure('Invalid encryption key.');
  try {
    // Check a visible sample where available, before accepting a replacement.
    const sample = grant.scope.split(/\s+/).includes('messages.read')
      ? await query(`SELECT content FROM messages WHERE agent_id=$1 AND encrypted=TRUE
        AND (hidden_from_agent=FALSE OR hidden_from_agent IS NULL) ORDER BY created_at DESC LIMIT 1`, [grant.agent_id])
      : { rows: [] };
    if (sample.rows[0]?.content) {
      try { const plain = vault.open(sample.rows[0].content, key); plain.fill(0); }
      catch (_error) { throw failure('This encryption key could not unlock the approved agent history. Try another password.'); }
    }
    const sealed = vault.wrap(key, grant);
    await query(`INSERT INTO mcp_hosted_connections(grant_id,user_id,agent_id,sealed_key) VALUES($1,$2,$3,$4)
      ON CONFLICT(grant_id) DO UPDATE SET sealed_key=EXCLUDED.sealed_key`, [grantId, ownerId, grant.agent_id, sealed]);
    return { mode: 'hosted', state: 'connected', browserRequired: false, agentId: grant.agent_id };
  } finally { key.fill(0); }
}
async function revoke(grantId) {
  await query('DELETE FROM mcp_hosted_connections WHERE grant_id=$1', [grantId]);
}
async function cleanupExpired() {
  await query(`DELETE FROM mcp_hosted_connections WHERE grant_id NOT IN (
    SELECT grant_id FROM mcp_oauth_tokens WHERE grant_id IS NOT NULL AND revoked_at IS NULL AND refresh_expires_at > NOW()
    UNION
    SELECT grant_id FROM mcp_oauth_codes WHERE grant_id IS NOT NULL AND consumed_at IS NULL AND expires_at > NOW()
  )`);
  await query("DELETE FROM mcp_hosted_retries WHERE created_at < NOW() - INTERVAL '7 days'");
}
function startCleanup() {
  const clean = () => cleanupExpired().catch(() => { console.error('Expired hosted MCP access could not be cleaned up.'); });
  clean();
  const timer = setInterval(clean, 5 * 60 * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
async function configurePeer(options, peerIdValue, encodedKey) {
  const ctx = await context(options);
  try {
    if (!ctx.scopes.includes('peers.read')) throw failure('Peer approval is required.');
    const peer = (await ctx.api('/api/agent/discover')).agents?.find(item => peerId(item) === peerIdValue && item.shared);
    if (!peer) throw failure('This shared peer is not currently permitted.');
    const key = Buffer.from(typeof encodedKey === 'string' ? encodedKey : '', 'base64');
    try {
      if (key.length !== 32 || key.toString('base64') !== encodedKey) throw failure('A valid shared peer key is required.');
      const sealed = vault.wrap(key, { ...ctx.grant, grant_id: `${ctx.grant.grant_id}:${peerIdValue}` });
      await query(`INSERT INTO mcp_hosted_peer_keys(grant_id,peer_id,sealed_key) VALUES($1,$2,$3)
        ON CONFLICT(grant_id,peer_id) DO UPDATE SET sealed_key=EXCLUDED.sealed_key`, [ctx.grant.grant_id, peerIdValue, sealed]);
      return { configured: true, peerId: peerIdValue };
    } finally { key.fill(0); }
  } finally { await ctx.close(); }
}

async function contentKey(ctx, peer) {
  if (!peer?.shared) return ctx.key;
  const row = (await query('SELECT sealed_key FROM mcp_hosted_peer_keys WHERE grant_id=$1 AND peer_id=$2', [ctx.grant.grant_id, peerId(peer)])).rows[0];
  if (!row) throw failure('This shared peer needs its separate encryption key. Configure it once in the connection page.');
  const key = vault.unwrap(row.sealed_key, { ...ctx.grant, grant_id: `${ctx.grant.grant_id}:${peerId(peer)}` });
  ctx.peerKeys.push(key);
  return key;
}

async function bytes(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw failure('The API response exceeded the configured limit.');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let size = 0;
  const parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw failure('The API response exceeded the configured limit.');
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts, size);
  } finally { await reader.cancel().catch(() => {}); }
}
function apiOrigin(origin) {
  const url = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw failure('The hosted MCP API origin must be HTTPS (or local loopback for development).');
  return url.origin;
}

async function context({ grantId, ownerId, origin }) {
  const grant = await activeGrant(grantId, ownerId);
  if (!grant?.hosted_approved) throw failure('The always-on message grant has expired or was revoked.');
  const record = await query('SELECT sealed_key FROM mcp_hosted_connections WHERE grant_id=$1 AND user_id=$2 AND agent_id=$3', [grantId, ownerId, grant.agent_id]);
  if (!record.rows[0]) throw failure('Finish the one-time encryption approval in ChatMCP.');
  let key;
  try { key = vault.unwrap(record.rows[0].sealed_key, grant); }
  catch (_error) { throw failure('The hosted key could not be unlocked. Restore the service wrapping key or reconnect in ChatMCP.'); }
  const scopes = grant.scope.split(/\s+/);
  const apiScopes = [];
  if (scopes.includes('messages.read')) apiScopes.push('agent.history.read', 'agent.responses.read');
  if (scopes.includes('messages.write')) apiScopes.push('agent.messages.write');
  if (scopes.includes('peers.read')) apiScopes.push('agent.dm.read', 'agent.discover.read');
  if (scopes.includes('peers.write')) apiScopes.push('agent.dm.write');
  if (scopes.includes(FILE_SCOPE_READ)) apiScopes.push('agent.attachments.read');
  if (scopes.includes(FILE_SCOPE_WRITE)) apiScopes.push('agent.attachments.write');
  let credential;
  try {
    const base = apiOrigin(origin);
    credential = await issueScopedCredential({ agentId: grant.agent_id, scopes: apiScopes, expiresAt: new Date(Date.now() + 120_000), mcpGrantId: grantId });
    const api = async (route, method = 'GET', payload, binary = false) => {
      // Fixed routes only, on the configured application origin. Never follow
      // redirects with a credential, and never take a URL from message content.
      if (!route.startsWith('/api/agent/') || route.includes('\\') || route.includes('#')) throw failure('Invalid agent API operation.');
      if (!await activeGrant(grantId, ownerId)) throw failure('The message grant was revoked.');
      const multipart = payload instanceof FormData;
      const response = await fetch(`${base}${route}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'X-Agent-Token': credential.token, 'X-Agent-Name': grant.agent_name,
          ...(payload && !multipart ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload ? { body: multipart ? payload : JSON.stringify(payload) } : {})
      });
      const body = await bytes(response, binary ? MAX_FILE_BYTES + 16 : 4 * 1024 * 1024);
      if (!response.ok) {
        let code;
        try { code = JSON.parse(body.toString('utf8')).error?.code; } catch (_error) { /* no response contents in errors */ }
        if (response.status === 409) throw failure('This idempotency ID conflicts with an earlier operation. Check the existing delivery before retrying.');
        throw failure(`The approved agent API denied or failed this operation (${response.status}${code ? `, ${code}` : ''}).`);
      }
      return binary ? body : JSON.parse(body.toString('utf8'));
    };
    const peerKeys = [];
    return { grant, scopes, key, peerKeys, api, close: async () => {
      key.fill(0);
      for (const peerKey of peerKeys) peerKey.fill(0);
      await query('UPDATE agent_api_credentials SET revoked_at=NOW() WHERE credential_id=$1', [credential.credentialId]);
    } };
  } catch (error) { key.fill(0); throw error; }
}

function attachmentMetadata(attachment) {
  const id = attachment.attachmentId || attachment.attachment_id;
  return { ...attachment, attachmentId: id, uri: resourceUri(id) };
}
function decryptItem(item, key) {
  const result = { ...item };
  if (result.encrypted && typeof result.content === 'string') result.content = vault.open(result.content, key).toString('utf8');
  for (const field of ['selectedOption', 'freeResponse']) {
    if (typeof result[field] === 'string' && result[field].split(':').length === 3) result[field] = vault.open(result[field], key).toString('utf8');
  }
  result.encrypted = false;
  if (result.updateAction) delete result.updateAction;
  if (result.responseId) { result.messageId = result.responseId; result.kind = 'response'; result.content = [result.selectedOption, result.freeResponse].filter(Boolean).join('\n'); }
  result.attachments = (result.attachments || []).map(attachmentMetadata);
  return result;
}
async function retryPayload(ctx, args, operation, proposed) {
  await query(`INSERT INTO mcp_hosted_retries(grant_id,idempotency_id,operation,recipient_id,payload)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(grant_id,idempotency_id) DO NOTHING`,
  [ctx.grant.grant_id, args.idempotencyId, operation, args.peerId || null, JSON.stringify(proposed)]);
  const row = (await query('SELECT operation,recipient_id,payload FROM mcp_hosted_retries WHERE grant_id=$1 AND idempotency_id=$2', [ctx.grant.grant_id, args.idempotencyId])).rows[0];
  if (row.operation !== operation || (row.recipient_id || null) !== (args.peerId || null)) throw failure('This idempotency ID already belongs to a different operation.');
  return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
}

async function operate(ctx, name, args) {
  const { api, key, grant, scopes } = ctx;
  const agentQuery = `agentName=${encodeURIComponent(grant.agent_name)}`;
  const discover = async () => (await api('/api/agent/discover')).agents || [];
  if (name === 'list_agents') return { agents: (await discover()).map(peer => ({ id: peerId(peer), name: peer.agentName, shared: !!peer.shared })) };
  if (name === 'read_inbox') {
    const limit = args.limit || 50;
    const inbox = await api(`/api/agent/responses?markRead=false&limit=${limit}&${agentQuery}`);
    const messages = (inbox.responses || []).map(item => ({ ...decryptItem(item, key), kind: item.responseId ? 'response' : 'user' }));
    if (scopes.includes('peers.read')) {
      const peers = await discover();
      const allowed = new Map(peers.map(peer => [peerId(peer), peer]));
      const direct = await api(`/api/agent/messages/direct?markRead=false&limit=${limit}`);
      for (const item of direct.messages || []) {
        if (!allowed.has(item.fromAgentId)) continue;
        try {
          messages.push({ ...decryptItem(item, await contentKey(ctx, allowed.get(item.fromAgentId))), kind: 'peer' });
        } catch (error) {
          if (!item.shared) throw error;
          messages.push({ messageId: item.messageId, kind: 'peer', fromAgentId: item.fromAgentId, requiresPeerKey: true, timestamp: item.timestamp });
        }
      }
    }
    messages.sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0) || String(a.messageId).localeCompare(String(b.messageId)));
    return { messages: messages.slice(0, limit) };
  }
  if (name === 'read_thread') {
    const data = await api(`/api/agent/messages/history?${agentQuery}&limit=${args.limit || 50}${args.beforeId ? `&beforeId=${args.beforeId}` : ''}`);
    const messages = [];
    const peers = scopes.includes('peers.read') ? await discover() : [];
    for (const item of data.messages || []) {
      if (['agent_dm_sent', 'agent_dm_received'].includes(item.type)) {
        const otherId = item.senderAgentId === grant.agent_id ? item.recipientAgentId : item.senderAgentId;
        const peer = peers.find(entry => peerId(entry) === otherId);
        if (!peer) continue;
        messages.push(decryptItem(item, await contentKey(ctx, peer)));
      } else messages.push(decryptItem(item, key));
    }
    return { agentId: grant.agent_id, messages, nextBeforeId: messages[0]?.messageId || null };
  }
  if (name === 'send_message' || name === 'send_peer_message') {
    let recipient;
    if (name === 'send_peer_message') {
      recipient = (await discover()).find(peer => peerId(peer) === args.peerId);
      if (!recipient) throw failure('This peer is no longer permitted for the approved agent.');
    }
    const messageKey = await contentKey(ctx, recipient);
    const attachmentIds = args.attachmentIds || [];
    const saved = await retryPayload(ctx, args, name, { content: vault.seal(Buffer.from(args.text || ' '), messageKey), attachmentIds });
    if (vault.open(saved.content, messageKey).toString('utf8') !== (args.text || ' ') || JSON.stringify(saved.attachmentIds) !== JSON.stringify(attachmentIds)) throw failure('This idempotency ID already belongs to different message content or attachments.');
    for (const id of attachmentIds) {
      const meta = await api(`/api/agent/attachments/${id}/metadata`);
      if ((meta.encryptionPeerId || null) !== (recipient?.shared ? peerId(recipient) : null)) throw failure('This attachment uses a different encryption audience. Upload it for this recipient before sending.');
    }
    const result = await api(name === 'send_message' ? '/api/agent/messages' : '/api/agent/messages/direct', 'POST', {
      ...(recipient ? { toAgentName: recipient.agentName } : { agentName: grant.agent_name }),
      content: saved.content, encrypted: true, clientMessageId: args.idempotencyId, attachmentIds,
      ...(recipient?.shared ? { toAgentName: peerId(recipient), encryptionScope: 'shared_dm_password' } : {})
    });
    return { sent: true, messageId: result.messageId, idempotencyId: args.idempotencyId, attachmentIds };
  }
  if (name === 'ack_message') {
    if (args.kind === 'peer') {
      const allowed = new Set((await discover()).map(peerId));
      const inbox = await api('/api/agent/messages/direct?markRead=false&limit=100');
      if (!(inbox.messages || []).some(item => item.messageId === args.messageId && allowed.has(item.fromAgentId))) throw failure('This peer message is not in the permitted inbox.');
    }
    return api(args.kind === 'peer' ? '/api/agent/messages/direct/ack' : '/api/agent/responses/ack', 'POST', { messageId: args.messageId, responseType: args.kind === 'response' ? 'response' : 'text' });
  }
  if (name === 'upload_attachment') {
    const recipient = args.peerId ? (await discover()).find(peer => peerId(peer) === args.peerId) : null;
    if (args.peerId && !recipient) throw failure('This peer is not currently permitted.');
    const fileKey = await contentKey(ctx, recipient);
    const data = Buffer.from(args.dataBase64, 'base64');
    if (data.length > MAX_FILE_BYTES || data.toString('base64') !== args.dataBase64) throw failure('File data must be canonical base64 within the configured attachment size limit.');
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const saved = await retryPayload(ctx, args, name, { ciphertext: vault.seal(data, fileKey), sha256, fileName: args.fileName, contentType: args.contentType });
    if (saved.sha256 !== sha256 || saved.fileName !== args.fileName || saved.contentType !== args.contentType) throw failure('This idempotency ID already belongs to another file.');
    if (saved.result) return saved.result;
    const [iv, tag, content] = saved.ciphertext.split(':');
    const form = new FormData();
    form.set('file', new Blob([Buffer.from(content, 'base64')], { type: saved.contentType }), saved.fileName);
    for (const [field, value] of Object.entries({ agentName: grant.agent_name, ivBase64: iv, authTagBase64: tag, contentType: saved.contentType, sha256, clientAttachmentId: args.idempotencyId })) form.set(field, value);
    if (recipient?.shared) form.set('encryptionPeerId', peerId(recipient));
    const result = attachmentMetadata(await api('/api/agent/attachments', 'POST', form));
    // After a confirmed upload, retain only the receipt and content fingerprint;
    // the large ciphertext now lives in the attachment storage provider.
    await query('UPDATE mcp_hosted_retries SET payload=$3::jsonb WHERE grant_id=$1 AND idempotency_id=$2', [grant.grant_id, args.idempotencyId,
      JSON.stringify({ sha256, fileName: saved.fileName, contentType: saved.contentType, result })]);
    return result;
  }
  if (name === 'read_attachment') {
    const meta = await api(`/api/agent/attachments/${args.attachmentId}/metadata`);
    const otherId = meta.peerAgentId || meta.encryptionPeerId;
    const peer = otherId && scopes.includes('peers.read') ? (await discover()).find(item => peerId(item) === otherId) : null;
    if (otherId && !peer) throw failure('This attachment peer is no longer permitted.');
    const fileKey = await contentKey(ctx, peer);
    const encrypted = await api(`/api/agent/attachments/${args.attachmentId}`, 'GET', undefined, true);
    const content = meta.encrypted === false ? encrypted : vault.open(`${meta.encryption.ivBase64}:${meta.encryption.tagBase64}:${encrypted.toString('base64')}`, fileKey);
    const offset = args.offset || 0;
    const length = args.length || MAX_CHUNK_BYTES;
    if (offset > content.length) throw failure('Attachment offset is past the end of the file.');
    const selected = content.subarray(offset, offset + length);
    return { attachmentId: args.attachmentId, uri: resourceUri(args.attachmentId), mimeType: meta.contentType, fileName: meta.fileName,
      sizeBytes: content.length, offset, dataBase64: selected.toString('base64'), nextOffset: offset + selected.length < content.length ? offset + selected.length : null };
  }
  throw failure('Unsupported hosted MCP operation.');
}

async function execute(options, name, args) {
  const count = calls.get(options.grantId) || 0;
  if (count >= 2 || [...calls.values()].reduce((sum, value) => sum + value, 0) >= 8) throw failure('Too many hosted operations are active. Retry shortly.');
  calls.set(options.grantId, count + 1);
  let ctx;
  try {
    ctx = await context(options);
    const result = await operate(ctx, name, args);
    if (!await activeGrant(options.grantId, options.ownerId)) throw failure('The grant was revoked before the result was delivered.');
    return result;
  } finally {
    try { if (ctx) await ctx.close(); }
    finally { const left = (calls.get(options.grantId) || 1) - 1; if (left) calls.set(options.grantId, left); else calls.delete(options.grantId); }
  }
}

module.exports = { enable, enabled, readiness, revoke, configurePeer, cleanupExpired, startCleanup, execute, resourceUri, MAX_FILE_BYTES, MAX_CHUNK_BYTES };
