'use strict';
const db = require('../db/connection');
const s = require('./service');

// Only account members, never anonymous guests, can delegate their own agents.
// Both ends must opt into listen_all; group names from different owners have
// no shared authority. The room owner separately enables this bridge.
async function peers(userId, agentId, client = db) {
  if (process.env.FEATURE_SHARED_CONVERSATIONS !== 'true') return [];
  const result = await client.query(`SELECT DISTINCT target.agent_id, target.agent_name,
    target.agent_type, target.last_seen_at, target.user_id, target.inter_agent_mode
    FROM agents caller JOIN agents target ON target.user_id<>caller.user_id
    JOIN shared_conversations room ON (room.agent_id=target.agent_id OR room.agent_id=caller.agent_id)
    JOIN shared_runtimes runtime ON runtime.agent_id=room.agent_id
      AND runtime.capabilities->>'executionMode'='trusted'
    JOIN shared_members member ON member.conversation_id=room.id
      AND member.user_id=CASE WHEN room.agent_id=target.agent_id THEN caller.user_id ELSE target.user_id END
    WHERE caller.agent_id=$1 AND caller.user_id=$2
      AND caller.inter_agent_mode='listen_all' AND target.inter_agent_mode='listen_all'
      AND room.allow_agent_messages=TRUE AND room.rotation_required=FALSE AND room.sharing_enabled=TRUE
      AND caller.stop_requested_at IS NULL AND target.stop_requested_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM shared_runtimes other_runtime
        WHERE other_runtime.agent_id IN (caller.agent_id,target.agent_id)
          AND COALESCE(other_runtime.capabilities->>'executionMode','')<>'trusted')
      AND NOT EXISTS (SELECT 1 FROM agent_chat_threads thread
        WHERE thread.conversation_id=room.id AND thread.state<>'shared')
      AND member.status='active' AND (member.expires_at IS NULL OR member.expires_at>NOW())
      AND NOT EXISTS (SELECT 1 FROM archived_agents aa WHERE aa.agent_id=caller.agent_id OR aa.agent_id=target.agent_id)`, [agentId, userId]);
  return result.rows;
}
async function settings(userId, roomId, enabled) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const room = (await client.query('SELECT * FROM shared_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE', [s.uuid(roomId), userId])).rows[0];
    s.check(room, 404, 'Shared conversation not found');
    if (enabled !== undefined) {
      s.check(typeof enabled === 'boolean', 400, 'enabled must be a boolean');
      await client.query('UPDATE shared_conversations SET allow_agent_messages=$2 WHERE id=$1', [room.id, enabled]);
      await client.query('INSERT INTO shared_audit(conversation_id,actor_id,action) VALUES($1,$2,$3)', [room.id, userId, enabled ? 'a2a_enabled' : 'a2a_disabled']);
    }
    await client.query('COMMIT');
    return {enabled: enabled === undefined ? room.allow_agent_messages === true : enabled};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
function encryptedContent(value) {
  if (typeof value !== 'string' || value.length > 100000) return false;
  const parts = value.split(':');
  return parts.length === 3 && parts.every(p => /^[A-Za-z0-9+/]+={0,2}$/.test(p)) &&
    Buffer.from(parts[0], 'base64').length === 12 && Buffer.from(parts[1], 'base64').length === 16 &&
    Buffer.from(parts[2], 'base64').length > 0;
}
module.exports = {peers, settings, encryptedContent};
