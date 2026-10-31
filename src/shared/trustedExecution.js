'use strict';

// Trusted collaborators use the owner's normal provider and tool permissions.
// Conversation access, runtime fencing and publication still remain server checks.
const policy = require('./executionPolicy');
const MAX_RUNTIME_MS = 3600000;
const isTrusted = runtime => runtime?.capabilities?.executionMode === 'trusted';
const one = async (client, sql, values) => (await client.query(sql, values)).rows[0];

async function requesterAccess(client, agentId, room, kind, id) {
  if (room.sharing_enabled === false && (kind !== 'user' || id !== room.owner_id)) return null;
  if (kind === 'user') {
    const member = await one(client, `SELECT expires_at FROM shared_members WHERE conversation_id=$1 AND user_id=$2
      AND status='active' AND (expires_at IS NULL OR expires_at>NOW())`, [room.id, id]);
    if (!member || member.expires_at && Date.parse(member.expires_at) <= Date.now()) return null;
    return { expiresAt: member.expires_at ? new Date(member.expires_at).toISOString() : null };
  }
  if (kind !== 'guest' || process.env.FEATURE_GUEST_SHARING !== 'true') return null;
  const share = await one(client, `SELECT gs.share_id,gs.revision,gs.expires_at FROM shared_guest_members gm
    JOIN guest_principals gp ON gp.guest_id=gm.guest_id AND gp.share_id=gm.share_id
    JOIN guest_shares gs ON gs.share_id=gm.share_id
    JOIN guest_share_agents ga ON ga.share_id=gm.share_id AND ga.agent_id=$3
    LEFT JOIN guest_share_rooms gr ON gr.share_id=gm.share_id AND gr.guest_id=gp.guest_id AND gr.agent_id=ga.agent_id
    WHERE gm.guest_id=$1 AND gm.conversation_id=$2 AND gm.status='active' AND gp.status<>'revoked'
      AND gs.revoked_at IS NULL AND (gs.expires_at IS NULL OR gs.expires_at>NOW()) AND ga.removed_at IS NULL
      AND gm.conversation_id=CASE WHEN gs.room_mode='common' THEN ga.room_id ELSE gr.room_id END`, [id, room.id, agentId]);
  if (!share || share.expires_at && Date.parse(share.expires_at) <= Date.now()) return null;
  return { shareId: share.share_id, shareRevision: Number(share.revision),
    expiresAt: share.expires_at ? new Date(share.expires_at).toISOString() : null };
}

function buildContext({ agent, room, task, requester, runtime, access }) {
  const context = policy.buildContext({ agent, room, task, requester, runtime });
  Object.assign(context.execution, { mode: 'trusted', isolation: 'owner-trusted', identityStatus: 'owner-connected' });
  Object.assign(context.authorization, { mode: 'trusted', ...access, budget: { maxRuntimeMs: MAX_RUNTIME_MS } });
  context.request.shareId = access.shareId || null;
  return context;
}

async function authorizeTask(client, task, room, runtime) {
  const context = task.execution_context;
  if (!isTrusted(runtime) || context?.execution?.mode !== 'trusted' ||
      context.execution.connectorId !== runtime.runtime_id || task.connector_id !== runtime.runtime_id ||
      context.request?.taskId !== task.task_id || context.request.requester?.kind !== task.requester_kind ||
      context.request.requester?.id !== task.requester_id || context.conversation?.id !== room.id ||
      context.conversation.membershipVersion !== Number(room.membership_version) ||
      context.conversation.keyVersion !== Number(room.key_version) || room.rotation_required) return null;
  const agent = await one(client, 'SELECT user_id,stop_requested_at FROM agents WHERE agent_id=$1', [task.agent_id]);
  if (!agent || agent.stop_requested_at || agent.user_id !== room.owner_id) return null;
  const access = await requesterAccess(client, task.agent_id, room, task.requester_kind, task.requester_id);
  if (!access || task.requester_kind === 'guest' && (access.shareId !== context.authorization?.shareId ||
      access.shareRevision !== context.authorization?.shareRevision)) return null;
  const maxRuntimeMs = context.authorization?.budget?.maxRuntimeMs;
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 1000 || maxRuntimeMs > MAX_RUNTIME_MS ||
      !Number.isFinite(Date.parse(task.claimed_at)) || Date.now() >= Date.parse(task.claimed_at) + maxRuntimeMs) return null;
  return { mode: 'trusted', budget: { maxRuntimeMs }, expires_at: access.expiresAt };
}

module.exports = { isTrusted, requesterAccess, buildContext, authorizeTask, MAX_RUNTIME_MS };
