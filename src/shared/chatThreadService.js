'use strict';

const db = require('../db/connection');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ChatThreadError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function check(ok, status, message) { if (!ok) throw new ChatThreadError(status, message); }
function validId(value) { return typeof value === 'string' && UUID.test(value); }
function capabilities(role, state, membershipStatus = 'active') {
  const active = membershipStatus === 'active';
  const owner = role === 'owner';
  const ready = state === 'shared' && active;
  return {
    read: owner || ready,
    send: owner ? state === 'private' || ready : ready,
    upload: owner ? state === 'private' || ready : ready,
    answer: owner ? state === 'private' || ready : ready,
    manageAccess: owner && state === 'shared',
    manageAgent: owner,
    stop: owner && state === 'shared'
  };
}
function context(row, { role, state, status = 'active', lastReadSeq = 0 } = {}) {
  return {
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    ownerId: row.owner_id,
    mode: row.mode || (state === 'private' || state === 'preparing' && role === 'owner' ? 'private' : 'shared'),
    state,
    role,
    membershipStatus: status,
    lastReadSeq: Number(lastReadSeq || 0),
    capabilities: capabilities(role, state, status)
  };
}

// Older common guest links may predate in-place sharing. Route the ordinary
// agent row to that live room without rewriting private history or room keys.
async function liveGuestThread(client, userId, agentId, primary) {
  if (primary.state === 'shared') return null;
  const schema = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='guest_shares'")).rows[0];
  if (!schema) return null;
  const room = (await client.query(`SELECT DISTINCT c.id AS conversation_id,c.agent_id,c.owner_id,a.agent_name,c.created_at
    FROM guest_share_agents sa JOIN guest_shares gs ON gs.share_id=sa.share_id
    JOIN shared_conversations c ON c.id=sa.room_id JOIN agents a ON a.agent_id=c.agent_id
    JOIN shared_members owner ON owner.conversation_id=c.id AND owner.user_id=$1 AND owner.role='owner' AND owner.status='active'
    JOIN shared_guest_members guest ON guest.conversation_id=c.id AND guest.share_id=gs.share_id AND guest.status='active'
    WHERE c.owner_id=$1 AND c.agent_id=$2 AND gs.room_mode='common' AND gs.revoked_at IS NULL
      AND (gs.expires_at IS NULL OR gs.expires_at>NOW()) AND sa.removed_at IS NULL
    ORDER BY c.created_at DESC LIMIT 1`, [userId, agentId])).rows[0];
  return room ? { ...context(room, { role: 'owner', state: 'shared' }), privateHistoryConversationId: primary.conversation_id } : null;
}
async function withPrivateHistory(current) {
  if (current.role !== 'owner' || current.mode !== 'shared') return current;
  const original = (await db.query("SELECT conversation_id FROM agent_chat_threads WHERE agent_id=$1 AND is_primary=TRUE AND state IN ('private','preparing')", [current.agentId])).rows[0];
  return original && original.conversation_id !== current.conversationId ? { ...current, privateHistoryConversationId: original.conversation_id } : current;
}

async function resolveAgentThread(userId, agentId) {
  check(validId(userId) && validId(agentId), 400, 'Invalid identifier');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const agent = (await client.query('SELECT agent_id, user_id, agent_name FROM agents WHERE agent_id=$1 FOR UPDATE', [agentId])).rows[0];
    check(agent && agent.user_id === userId, 404, 'Agent not found');
    let thread = (await client.query('SELECT conversation_id, agent_id, owner_id, state FROM agent_chat_threads WHERE agent_id=$1 AND is_primary=TRUE', [agentId])).rows[0];
    if (!thread) {
      thread = (await client.query(`INSERT INTO agent_chat_threads(agent_id,owner_id)
        VALUES($1,$2) RETURNING conversation_id,agent_id,owner_id,state`, [agentId, userId])).rows[0];
    }
    const guestThread = await liveGuestThread(client, userId, agentId, thread);
    await client.query('COMMIT');
    return guestThread || context({ ...thread, agent_name: agent.agent_name }, { role: 'owner', state: thread.state });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function getChatContext(userId, conversationId) {
  check(validId(userId) && validId(conversationId), 400, 'Invalid identifier');
  const bound = (await db.query(`SELECT t.conversation_id,t.agent_id,t.owner_id,t.state,a.agent_name
    FROM agent_chat_threads t JOIN agents a ON a.agent_id=t.agent_id
    WHERE t.conversation_id=$1`, [conversationId])).rows[0];
  if (bound && bound.owner_id === userId) return withPrivateHistory(context(bound, { role: 'owner', state: bound.state }));

  const membership = (await db.query(`SELECT c.id AS conversation_id,c.agent_id,c.owner_id,a.agent_name,
      m.role,m.status,m.last_read_seq
    FROM shared_conversations c JOIN agents a ON a.agent_id=c.agent_id
    JOIN shared_members m ON m.conversation_id=c.id
    WHERE c.id=$1 AND m.user_id=$2 AND m.status IN ('active','pending','invited')`, [conversationId, userId])).rows[0];
  check(membership, 404, 'Conversation not found');
  return withPrivateHistory(context({ ...membership, mode: 'shared' }, { role: membership.role, status: membership.status, state: 'shared', lastReadSeq: membership.last_read_seq }));
}

async function assertPrivateThreadWritable(client, agentId, ownerId) {
  const binding = (await client.query(`SELECT state FROM agent_chat_threads
    WHERE agent_id=$1 AND owner_id=$2 AND is_primary=TRUE FOR UPDATE`, [agentId, ownerId])).rows[0];
  check(!binding || binding.state === 'private', 409, 'This chat is preparing or shared. Refresh the dashboard and use its conversation context.');
  return true;
}

// A completed private turn must still be deliverable after its ordinary chat
// was shared. Keep its account-encrypted reply in owner-only private history;
// only the scoped agent owning the current, certain private lease may do this.
async function assertPrivateAgentReplyWritable(client, agentId, ownerId, lease = null) {
  try { return await assertPrivateThreadWritable(client, agentId, ownerId); }
  catch (error) {
    if (error.status !== 409 || !validId(lease?.runtimeId) || !validId(lease?.executionId)) throw error;
    const runtime = (await client.query('SELECT * FROM shared_runtimes WHERE agent_id=$1 FOR UPDATE', [agentId])).rows[0];
    check(runtime && runtime.runtime_id === lease.runtimeId && runtime.execution_id === lease.executionId &&
      runtime.execution_kind === 'private' && !runtime.execution_uncertain &&
      Date.now() - new Date(runtime.last_seen_at).getTime() < 120000, 409,
    'A current private execution is required to deliver this owner-only reply.');
    return true;
  }
}

async function listChatThreads(userId) {
  check(validId(userId), 400, 'Invalid identifier');
  const owned = (await db.query(`SELECT a.agent_id,a.user_id AS owner_id,a.agent_name,
      t.conversation_id,COALESCE(t.state,'private') AS state
    FROM agents a LEFT JOIN agent_chat_threads t ON t.agent_id=a.agent_id AND t.is_primary=TRUE
    WHERE a.user_id=$1 ORDER BY a.position,a.agent_name`, [userId])).rows;
  const result = [];
  for (const row of owned) {
    const resolved = row.conversation_id ? await liveGuestThread(db, userId, row.agent_id, row) : await resolveAgentThread(userId, row.agent_id);
    result.push(resolved || context(row, { role: 'owner', state: row.state }));
  }
  const shared = (await db.query(`SELECT c.id AS conversation_id,c.agent_id,c.owner_id,a.agent_name,
      m.role,m.status,m.last_read_seq
    FROM shared_members m JOIN shared_conversations c ON c.id=m.conversation_id
    JOIN agents a ON a.agent_id=c.agent_id
    LEFT JOIN agent_chat_threads t ON t.conversation_id=c.id
    WHERE m.user_id=$1 AND m.status IN ('active','pending','invited')
      AND (t.conversation_id IS NULL OR t.state='shared')
    ORDER BY c.created_at DESC`, [userId])).rows;
  const seen = new Set(result.map(row => row.conversationId));
  for (const row of shared) {
    if (seen.has(row.conversation_id)) continue;
    seen.add(row.conversation_id);
    result.push(context({ ...row, mode: 'shared' }, {
    role: row.role,
    status: row.status,
    state: 'shared',
    lastReadSeq: row.last_read_seq
    }));
  }
  return result;
}

async function adoptExistingSharedThread(userId, roomId) {
  const current = await getChatContext(userId, roomId);
  check(current.state === 'shared', 409, 'Conversation is not active');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`SELECT c.id,c.agent_id,c.owner_id,a.agent_name
      FROM shared_conversations c JOIN agents a ON a.agent_id=c.agent_id
      WHERE c.id=$1 AND c.owner_id=$2 FOR UPDATE`, [roomId, userId])).rows[0];
    check(row, 403, 'Only the owner can bind this conversation');
    await client.query(`INSERT INTO agent_chat_threads(conversation_id,agent_id,owner_id,is_primary,state,activated_at)
      VALUES($1,$2,$3,FALSE,'shared',NOW()) ON CONFLICT(conversation_id) DO UPDATE SET state='shared',activated_at=COALESCE(agent_chat_threads.activated_at,NOW())`, [roomId,row.agent_id,userId]);
    await client.query('COMMIT');
    return context({ ...row, conversation_id: roomId }, { role: 'owner', state: 'shared' });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

module.exports = { ChatThreadError, capabilities, resolveAgentThread, getChatContext, listChatThreads, adoptExistingSharedThread, assertPrivateThreadWritable, assertPrivateAgentReplyWritable };
