const crypto = require('crypto');

// Message bodies and results exist only in this process while an MCP call is
// being serviced. Use one process; multiple workers require grant-aware routing
// shared by browser requests and MCP bearer-token requests, not cookie affinity.
const MAX_CONNECTIONS = 1000;
const MAX_PENDING_PER_CONNECTION = 8;
const MAX_QUEUE_PER_CONNECTION = 32;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const REQUEST_TTL_MS = 30_000;
const HEARTBEAT_TTL_MS = 20_000;
const CONNECTION_TTL_MS = 12 * 60 * 60 * 1000;
const connections = new Map();

function token() { return crypto.randomBytes(32).toString('base64url'); }
function byteLength(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function safeError(message, code = 'GATEWAY_OFFLINE') {
  const error = new Error(message);
  error.code = code;
  return error;
}
function cleanupConnection(connection, reason = 'Gateway disconnected') {
  connections.delete(connection.id);
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(safeError(reason, 'GATEWAY_OFFLINE'));
  }
  connection.pending.clear();
  connection.queue.length = 0;
  connection.closed = true;
}
function expire() {
  const now = Date.now();
  for (const connection of connections.values()) {
    if (connection.expiresAt <= now) cleanupConnection(connection, 'Browser connection expired. Reconnect in the ChatMCP tab.');
    for (const [id, pending] of connection.pending) {
      if (pending.expiresAt <= now) {
        connection.pending.delete(id);
        connection.queue = connection.queue.filter(item => item.id !== id);
        clearTimeout(pending.timer);
        pending.reject(safeError('The browser connection timed out. The send outcome may be uncertain; retry with the same idempotency ID.', 'GATEWAY_TIMEOUT'));
      }
    }
    if (now - connection.lastSeenAt > HEARTBEAT_TTL_MS) cleanupConnection(connection, 'The browser connection is offline. Reopen the ChatMCP connection tab.');
  }
}
const reaper = setInterval(expire, 5000);
reaper.unref?.();

function enroll({ ownerId, grantId, sessionId }) {
  expire();
  if (!ownerId || !grantId) throw safeError('A valid owner and grant are required.', 'INVALID_GRANT');
  for (const connection of connections.values()) {
    if (connection.ownerId === ownerId && connection.grantId === grantId) cleanupConnection(connection, 'This browser connection was replaced.');
  }
  if (connections.size >= MAX_CONNECTIONS) throw safeError('The browser gateway is at capacity. Try again shortly.', 'GATEWAY_CAPACITY');
  const connection = {
    id: token(), secret: token(), ownerId, grantId, sessionId, createdAt: Date.now(),
    expiresAt: Date.now() + CONNECTION_TTL_MS, queue: [], pending: new Map(),
    closed: false, lastSeenAt: Date.now()
  };
  connections.set(connection.id, connection);
  return { connectionId: connection.id, gatewaySecret: connection.secret, expiresAt: connection.expiresAt };
}

function getConnection({ connectionId, gatewaySecret, ownerId, sessionId }) {
  expire();
  const connection = connections.get(connectionId);
  if (!connection || connection.closed || connection.secret !== gatewaySecret || connection.ownerId !== ownerId || connection.sessionId !== sessionId) return null;
  connection.lastSeenAt = Date.now();
  return connection;
}

function status({ connectionId, gatewaySecret, ownerId, sessionId }) {
  const connection = getConnection({ connectionId, gatewaySecret, ownerId, sessionId });
  if (!connection) return { state: 'offline' };
  return { state: 'connected', pending: connection.pending.size, expiresAt: connection.expiresAt };
}

function connectionGrantId({ connectionId, gatewaySecret, ownerId, sessionId }) {
  const connection = getConnection({ connectionId, gatewaySecret, ownerId, sessionId });
  return connection?.grantId || null;
}

function statusForGrant({ ownerId, grantId }) {
  expire();
  const connection = [...connections.values()].find(item => item.ownerId === ownerId && item.grantId === grantId && !item.closed);
  if (!connection || Date.now() - connection.lastSeenAt > HEARTBEAT_TTL_MS) return { state: 'offline' };
  return { state: 'connected', pending: connection.pending.size, expiresAt: connection.expiresAt };
}

function request({ ownerId, grantId, operation, args = {} }) {
  expire();
  if (!['read_inbox', 'read_thread', 'send_message', 'send_peer_message', 'ack_message', 'list_agents'].includes(operation)) {
    return Promise.reject(safeError('Unsupported browser operation.', 'INVALID_OPERATION'));
  }
  let size;
  try { size = byteLength({ operation, args }); } catch (_error) { return Promise.reject(safeError('Invalid operation arguments.', 'INVALID_REQUEST')); }
  if (size > MAX_REQUEST_BYTES) return Promise.reject(safeError('Message request is too large.', 'REQUEST_TOO_LARGE'));
  const connection = [...connections.values()].find(item => item.ownerId === ownerId && item.grantId === grantId && !item.closed && item.expiresAt > Date.now() && Date.now() - item.lastSeenAt <= HEARTBEAT_TTL_MS);
  if (!connection) return Promise.reject(safeError('The ChatMCP browser connection is offline. Open the connection page and reconnect.', 'GATEWAY_OFFLINE'));
  if (connection.pending.size >= MAX_PENDING_PER_CONNECTION || connection.queue.length >= MAX_QUEUE_PER_CONNECTION) {
    return Promise.reject(safeError('Too many browser operations are waiting. Retry shortly.', 'GATEWAY_BUSY'));
  }
  const id = token();
  return new Promise((resolve, reject) => {
    const expiresAt = Date.now() + REQUEST_TTL_MS;
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      connection.queue = connection.queue.filter(item => item.id !== id);
      reject(safeError('The browser connection timed out. The send outcome may be uncertain; retry with the same idempotency ID.', 'GATEWAY_TIMEOUT'));
    }, REQUEST_TTL_MS);
    connection.pending.set(id, { resolve, reject, timer, expiresAt, claimed: false });
    connection.queue.push({ id, operation, args, expiresAt });
  });
}

function claim({ connectionId, gatewaySecret, ownerId, sessionId }) {
  const connection = getConnection({ connectionId, gatewaySecret, ownerId, sessionId });
  if (!connection) return null;
  while (connection.queue.length) {
    const item = connection.queue.shift();
    const pending = connection.pending.get(item.id);
    if (pending && item.expiresAt > Date.now() && !pending.claimed) { pending.claimed = true; return item; }
  }
  return null;
}

function complete({ connectionId, gatewaySecret, ownerId, sessionId, requestId, result, error }) {
  const connection = getConnection({ connectionId, gatewaySecret, ownerId, sessionId });
  if (!connection || typeof requestId !== 'string') return false;
  const pending = connection.pending.get(requestId);
  if (!pending || !pending.claimed || pending.expiresAt <= Date.now()) return false;
  if (!error) {
    let size;
    try { size = byteLength(result); } catch (_error) { size = MAX_RESULT_BYTES + 1; }
    if (size > MAX_RESULT_BYTES) error = 'The browser result exceeded the allowed size.';
  }
  connection.pending.delete(requestId);
  clearTimeout(pending.timer);
  if (error) pending.reject(safeError(String(error).slice(0, 300), 'GATEWAY_OPERATION_FAILED'));
  else pending.resolve(result);
  return true;
}

function disconnect({ connectionId, gatewaySecret, ownerId, sessionId }) {
  const connection = getConnection({ connectionId, gatewaySecret, ownerId, sessionId });
  if (!connection) return false;
  cleanupConnection(connection, 'The ChatMCP browser connection was disconnected.');
  return true;
}

function revokeGrant(grantId) {
  for (const connection of connections.values()) if (connection.grantId === grantId) cleanupConnection(connection, 'The message grant was revoked.');
}

function _resetForTests() {
  for (const connection of connections.values()) cleanupConnection(connection, 'Test reset');
}

module.exports = { enroll, status, statusForGrant, connectionGrantId, request, claim, complete, disconnect, revokeGrant, _resetForTests, _limits: { MAX_REQUEST_BYTES, MAX_RESULT_BYTES, MAX_PENDING_PER_CONNECTION, MAX_QUEUE_PER_CONNECTION, REQUEST_TTL_MS, HEARTBEAT_TTL_MS } };
