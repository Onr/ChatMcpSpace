const { query } = require('../db/connection');

async function permitted(userId, callerId, otherId) {
  const rows = (await query('SELECT agent_id,user_id,inter_agent_mode FROM agents WHERE agent_id IN ($1,$2)', [callerId, otherId])).rows;
  const caller = rows.find(row => row.agent_id === callerId && row.user_id === userId);
  const other = rows.find(row => row.agent_id === otherId);
  if (!caller || !other || !caller.inter_agent_mode || !other.inter_agent_mode || caller.inter_agent_mode === 'disabled' || other.inter_agent_mode === 'disabled') return false;
  if (other.user_id !== userId) return (await require('../shared/a2aAccess').peers(userId, callerId)).some(row => row.agent_id === otherId);
  const archived = await query('SELECT 1 FROM archived_agents WHERE agent_id IN ($1,$2) LIMIT 1', [callerId, otherId]);
  if (archived.rows.length) return false;
  if (caller.inter_agent_mode === 'listen_all' || other.inter_agent_mode === 'listen_all') return true;
  const groups = await query(`SELECT 1 FROM agent_group_members mine JOIN agent_group_members theirs ON theirs.group_id=mine.group_id
    WHERE mine.agent_id=$1 AND theirs.agent_id=$2 LIMIT 1`, [callerId, otherId]);
  return groups.rows.length > 0;
}
async function accessible(req, attachmentId) {
  const bound = req.authContext?.type === 'agent_token' ? req.authContext.agentId : null;
  if (!bound) return null;
  const scopes = req.authContext.scopes || [];
  if (!scopes.some(scope => ['agent.dm.read', 'agent.dm.*', 'agent.*', '*'].includes(scope))) return null;
  const links = await query(`SELECT a.*, m.sender_agent_id,m.recipient_agent_id FROM attachments a
    JOIN agent_message_attachments link ON link.attachment_id=a.attachment_id
    JOIN agent_messages m ON m.agent_message_id=link.agent_message_id
    WHERE a.attachment_id=$1 AND (m.recipient_agent_id=$2 OR m.sender_agent_id=$2)`, [attachmentId, bound]);
  for (const row of links.rows) {
    const other = row.sender_agent_id === bound ? row.recipient_agent_id : row.sender_agent_id;
    if (await permitted(req.user.userId, bound, other)) return { ...row, peer_agent_id: other };
  }
  return null;
}
async function metadataMap(ids) {
  const result = new Map();
  if (!ids.length) return result;
  const rows = await query(`SELECT link.agent_message_id,a.attachment_id,a.content_type,a.file_name,a.size_bytes,a.encrypted,a.iv_base64,a.auth_tag_base64
    FROM agent_message_attachments link JOIN attachments a ON a.attachment_id=link.attachment_id
    WHERE link.agent_message_id IN (${ids.map((_, index) => `$${index + 1}`).join(',')}) ORDER BY link.attachment_order`, ids);
  for (const row of rows.rows) {
    const entries = result.get(row.agent_message_id) || [];
    entries.push({ attachmentId: row.attachment_id, contentType: row.content_type, fileName: row.file_name, sizeBytes: Number(row.size_bytes), encrypted: row.encrypted,
      encryption: row.encrypted ? { alg: 'AES-GCM', ivBase64: row.iv_base64, tagBase64: row.auth_tag_base64 } : null });
    result.set(row.agent_message_id, entries);
  }
  return result;
}
module.exports = { permitted, accessible, metadataMap };
