'use strict';

const crypto = require('crypto');
const db = require('../db/connection');
const s = require('./service');
const policy = require('./executionPolicy');
const trustedExecution = require('./trustedExecution');
const ACTIVE = ['running', 'paused', 'waiting_for_approval'];

async function tx(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function one(client, sql, values) { return (await client.query(sql, values)).rows[0]; }
function canonical(value, depth = 0) {
  s.check(depth <= 12, 400, 'Action parameters are too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { s.check(Number.isFinite(value), 400, 'Invalid action number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  s.check(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 400, 'Invalid action parameters');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
}
function descriptor(body) {
  const label = (value, optional = false, actionName = false) => {
    if (optional && (value === undefined || value === null || value === '')) return null;
    s.check(typeof value === 'string' && value.length > 0 && value.length <= 120 && value.trim() === value &&
      !/[\x00-\x1f\x7f*]/.test(value) && (!actionName || /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(value)), 400, 'Invalid action scope');
    return value;
  };
  const result = { name: label(body?.name, false, true), resource: label(body?.resource), destination: label(body?.destination, true), parameters: body?.parameters ?? {} };
  s.check(Buffer.byteLength(canonical(result)) <= 16000, 400, 'Action parameters exceed 16 KB');
  return result;
}
function digest(task, action) {
  return crypto.createHash('sha256').update(canonical({ taskId: task.task_id, grantId: task.grant_id,
    revision: Number(task.grant_revision), deviceId: task.device_id, deviceEpoch: Number(task.device_epoch), action })).digest('hex');
}
async function lockTask(client, taskId, runtime = null) {
  s.uuid(taskId);
  const target = await one(client, 'SELECT * FROM shared_tasks WHERE task_id=$1', [taskId]);
  s.check(target, 404, 'Task unavailable');
  await s.lockTaskShare(client, taskId);
  if (runtime) {
    s.check(target.agent_id === runtime.agentId, 404, 'Task unavailable');
    const current = await s.runtimeInTransaction(client, runtime.agentId, runtime.runtimeId, runtime.credentialId);
    s.check(current.execution_id === taskId && current.runtime_id === target.connector_id, 409, 'Task belongs to another execution');
  }
  const room = await one(client, 'SELECT * FROM shared_conversations WHERE id=$1 FOR UPDATE', [target.conversation_id]);
  s.check(room, 404, 'Task conversation unavailable');
  const task = await one(client, 'SELECT * FROM shared_tasks WHERE task_id=$1 FOR UPDATE', [taskId]);
  return { task, room };
}
async function currentAuthorization(client, task, room) {
  if (!ACTIVE.includes(task.state)) return null;
  if (task.execution_context?.execution?.mode === 'trusted') {
    const runtime = await one(client, 'SELECT * FROM shared_runtimes WHERE agent_id=$1', [task.agent_id]);
    return trustedExecution.authorizeTask(client, task, room, runtime);
  }
  const agent = await one(client, 'SELECT user_id,stop_requested_at FROM agents WHERE agent_id=$1', [task.agent_id]);
  if (!agent || agent.stop_requested_at || agent.user_id !== room.owner_id) return null;
  if (task.requester_kind === 'user') {
    const member = await one(client, `SELECT user_id FROM shared_members WHERE conversation_id=$1 AND user_id=$2
      AND status='active' AND (expires_at IS NULL OR expires_at>NOW())`, [room.id, task.requester_id]);
    if (!member) return null;
  }
  const grant = await s.executionGrant(client, task.agent_id, room.id, task.requester_kind, task.requester_id, task.device_id);
  if (!grant || grant.grant_id !== task.grant_id || Number(grant.revision) !== Number(task.grant_revision) ||
      Number(grant.credential_epoch) !== Number(task.device_epoch) || grant.owner_id !== agent.user_id || room.rotation_required ||
      task.execution_context?.conversation?.membershipVersion !== Number(room.membership_version) ||
      task.execution_context?.conversation?.keyVersion !== Number(room.key_version)) return null;
  try { policy.assertTaskContext(task.execution_context, { taskId: task.task_id, grantId: task.grant_id, revision: task.grant_revision, deviceId: task.device_id }); }
  catch (_) { return null; }
  const milliseconds = grant.budget?.maxRuntimeMs;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1000 || milliseconds > 900000 ||
      Date.now() >= new Date(task.claimed_at).getTime() + milliseconds) return null;
  return grant;
}
async function revokePending(client, task, reason) {
  await client.query(`UPDATE shared_task_actions SET approval_state='revoked'
    WHERE task_id=$1 AND approval_state IN ('pending','approved') AND consumed_at IS NULL`, [task.task_id]);
  if (ACTIVE.includes(task.state)) await client.query(`UPDATE shared_tasks SET state='cancellation_requested',
    cancellation_requested_at=COALESCE(cancellation_requested_at,NOW()),current_authorization=$2 WHERE task_id=$1`,
  [task.task_id, JSON.stringify({ state: 'revoked', reason })]);
}
async function authorize(runtime, taskId) {
  return tx(async client => {
    const { task, room } = await lockTask(client, taskId, runtime);
    const grant = await currentAuthorization(client, task, room);
    if (!grant) await revokePending(client, task, 'Task scope, audience, budget or authority changed');
    return { taskId, authorized: Boolean(grant), state: grant ? task.state : ACTIVE.includes(task.state) ? 'cancellation_requested' : task.state,
      deadlineAt: grant ? new Date(Math.min(new Date(task.claimed_at).getTime() + grant.budget.maxRuntimeMs,
        grant.expires_at ? new Date(grant.expires_at).getTime() : Infinity)).toISOString() : null };
  });
}
function publicAction(action) {
  return { actionId: action.action_id, taskId: action.task_id, digest: action.action_digest, name: action.action_name,
    resource: action.resource, destination: action.destination, approvalState: action.approval_state,
    expiresAt: action.expires_at, outcome: action.outcome, approvedBy: action.approved_by || null,
    receipt: action.external_receipt, ...(action.execution_nonce ? { executionNonce: action.execution_nonce } : {}) };
}
async function propose(runtime, taskId, body) {
  const actionId = s.uuid(body?.actionId), action = descriptor(body);
  return tx(async client => {
    const { task, room } = await lockTask(client, taskId, runtime);
    const grant = await currentAuthorization(client, task, room);
    s.check(grant, 403, 'Current task authorization is unavailable');
    s.check(grant.mode !== 'trusted', 409, 'Trusted sharing uses the agent\'s existing tool permissions');
    s.check(grant.actions.includes(action.name) && !(grant.approval_policy?.denied || []).includes(action.name), 403, 'Action is outside the current grant');
    s.check(grant.resources.includes(action.resource), 403, 'Resource is outside the current grant');
    s.check(!action.destination || grant.destinations.includes(action.destination), 403, 'Destination is outside the current grant');
    const actionDigest = digest(task, action);
    const previous = await one(client, 'SELECT * FROM shared_task_actions WHERE action_id=$1 FOR UPDATE', [actionId]);
    if (previous) {
      s.check(previous.task_id === taskId && previous.action_digest === actionDigest, 409, 'Operation identity is already bound to another action');
      return publicAction(previous);
    }
    const needsApproval = (grant.approval_policy?.requiresApproval || []).includes(action.name);
    const expiresAt = new Date(Math.min(Date.now() + 300000, new Date(task.claimed_at).getTime() + grant.budget.maxRuntimeMs,
      grant.expires_at ? new Date(grant.expires_at).getTime() : Infinity));
    const saved = await one(client, `INSERT INTO shared_task_actions
      (action_id,task_id,action_digest,action_name,resource,destination,grant_id,grant_revision,device_epoch,action_payload,approval_state,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [actionId, taskId, actionDigest, action.name, action.resource, action.destination, task.grant_id, task.grant_revision, task.device_epoch,
      JSON.stringify(action), needsApproval ? 'pending' : 'not_required', expiresAt]);
    if (needsApproval) await client.query("UPDATE shared_tasks SET state='waiting_for_approval' WHERE task_id=$1", [taskId]);
    return publicAction(saved);
  });
}
async function decide(userId, taskId, actionId, body) {
  s.check(['approve', 'deny'].includes(body?.decision), 400, 'Choose approve or deny');
  return tx(async client => {
    const { task, room } = await lockTask(client, taskId);
    // The authenticated owner decides, including for their own scoped request.
    // Chat content and a requester-supplied boolean cannot impersonate this API.
    s.check(room.owner_id === s.uuid(userId), 403, 'Only the agent owner can decide this approval');
    const grant = await currentAuthorization(client, task, room);
    s.check(grant, 403, 'Current task authorization is unavailable');
    const action = await one(client, 'SELECT * FROM shared_task_actions WHERE action_id=$1 AND task_id=$2 FOR UPDATE', [s.uuid(actionId), taskId]);
    s.check(action && action.approval_state === 'pending' && !action.consumed_at, 409, 'Approval is no longer pending');
    s.check(body.digest === action.action_digest && action.action_digest === digest(task, action.action_payload) &&
      action.grant_id === task.grant_id && Number(action.grant_revision) === Number(task.grant_revision) &&
      Number(action.device_epoch) === Number(task.device_epoch), 409, 'Approval does not match this exact action');
    s.check(Date.now() < new Date(action.expires_at).getTime(), 409, 'Approval has expired');
    const saved = await one(client, `UPDATE shared_task_actions SET approval_state=$2,approved_by=$3,decided_at=NOW()
      WHERE action_id=$1 RETURNING *`, [actionId, body.decision === 'approve' ? 'approved' : 'denied', userId]);
    return publicAction(saved);
  });
}
async function start(runtime, taskId, actionId, body) {
  return tx(async client => {
    const { task, room } = await lockTask(client, taskId, runtime);
    const grant = await currentAuthorization(client, task, room);
    s.check(grant, 403, 'Current task authorization is unavailable');
    const action = await one(client, 'SELECT * FROM shared_task_actions WHERE action_id=$1 AND task_id=$2 FOR UPDATE', [s.uuid(actionId), taskId]);
    s.check(action && body?.digest === action.action_digest && action.action_digest === digest(task, action.action_payload), 409, 'Exact action digest required');
    s.check(!action.consumed_at && !action.outcome && Date.now() < new Date(action.expires_at).getTime(), 409, 'Action is expired or already consumed; inspect its receipt');
    s.check(['approved', 'not_required'].includes(action.approval_state), 403, 'Owner approval is required');
    s.check(grant.actions.includes(action.action_name) && !(grant.approval_policy?.denied || []).includes(action.action_name) &&
      grant.resources.includes(action.resource) && (!action.destination || grant.destinations.includes(action.destination)), 403, 'Action scope changed');
    const saved = await one(client, `UPDATE shared_task_actions SET consumed_at=NOW(),execution_nonce=$2,outcome='running'
      WHERE action_id=$1 RETURNING *`, [actionId, crypto.randomUUID()]);
    await client.query("UPDATE shared_tasks SET state='running' WHERE task_id=$1", [taskId]);
    return publicAction(saved);
  });
}
async function complete(runtime, taskId, actionId, body) {
  s.check(['succeeded', 'failed', 'outcome_uncertain'].includes(body?.outcome), 400, 'Invalid action outcome');
  const receipt = body.receipt || {};
  s.check(Buffer.byteLength(canonical(receipt)) <= 2000 && Object.keys(receipt).every(key =>
    ['exitCode', 'durationMs', 'outputHash', 'confirmedStopped'].includes(key)), 400, 'Invalid action receipt');
  s.check((receipt.exitCode === undefined || receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode)) &&
    (receipt.durationMs === undefined || Number.isSafeInteger(receipt.durationMs) && receipt.durationMs >= 0) &&
    (receipt.outputHash === undefined || typeof receipt.outputHash === 'string' && /^[a-f0-9]{64}$/.test(receipt.outputHash)) &&
    (receipt.confirmedStopped === undefined || typeof receipt.confirmedStopped === 'boolean'), 400, 'Invalid action receipt');
  return tx(async client => {
    await lockTask(client, taskId, runtime);
    const action = await one(client, 'SELECT * FROM shared_task_actions WHERE action_id=$1 AND task_id=$2 FOR UPDATE', [s.uuid(actionId), taskId]);
    s.check(action?.consumed_at && action.execution_nonce === body.executionNonce, 409, 'Action execution identity mismatch');
    if (action.outcome !== 'running') {
      s.check(action.outcome === body.outcome && canonical(action.external_receipt) === canonical(receipt), 409, 'A different action outcome is already retained');
      return publicAction(action);
    }
    const saved = await one(client, `UPDATE shared_task_actions SET outcome=$2,external_receipt=$3,completed_at=NOW()
      WHERE action_id=$1 RETURNING *`, [actionId, body.outcome, JSON.stringify(receipt)]);
    if (body.outcome === 'outcome_uncertain') await client.query("UPDATE shared_tasks SET state='outcome_uncertain' WHERE task_id=$1", [taskId]);
    return publicAction(saved);
  });
}
async function cancel(userId, taskId, guestCredentials = null) {
  return tx(async client => {
    let guestAccess = null;
    if (guestCredentials) {
      const target = await one(client, 'SELECT conversation_id FROM shared_tasks WHERE task_id=$1', [s.uuid(taskId)]);
      s.check(target, 404, 'Task unavailable');
      guestAccess = await require('./guestService').currentGuestAccessInTransaction(client,
        guestCredentials.sessionId, guestCredentials.sessionTokenHash, target.conversation_id);
    }
    const { task, room } = await lockTask(client, taskId);
    s.check(guestAccess ? task.requester_kind === 'guest' && task.requester_id === guestAccess.guest.guest_id &&
      task.conversation_id === guestAccess.room.id : room.owner_id === userId || task.requester_kind === 'user' && task.requester_id === userId,
    403, 'Only the requester or agent owner can cancel this task');
    if (!guestAccess && room.owner_id !== userId) {
      const member = await one(client, `SELECT user_id FROM shared_members WHERE conversation_id=$1 AND user_id=$2
        AND status='active' AND (expires_at IS NULL OR expires_at>NOW())`, [room.id, s.uuid(userId)]);
      s.check(member, 404, 'Shared conversation unavailable');
    }
    await revokePending(client, task, 'Cancellation requested');
    if (['queued', 'unsupported_runtime'].includes(task.state)) {
      // No process has launched for these states. Consume the source messages so
      // a later grant cannot silently execute a request the person cancelled.
      const batchId = crypto.randomUUID();
      await client.query(`INSERT INTO shared_batches(id,conversation_id,agent_id,status,task_id,completed_at)
        VALUES($1,$2,$3,'skipped',$4,NOW())`, [batchId, room.id, task.agent_id, taskId]);
      for (const messageId of task.source_message_ids) await client.query(`UPDATE shared_messages SET batch_id=$2
        WHERE id=$1 AND conversation_id=$3 AND batch_id IS NULL`, [s.uuid(messageId), batchId, room.id]);
      await client.query(`UPDATE shared_tasks SET state='cancellation_confirmed',cancellation_requested_at=NOW(),
        cancellation_confirmed_at=NOW(),completed_at=NOW() WHERE task_id=$1`, [taskId]);
      return { taskId, state: 'cancellation_confirmed' };
    }
    return { taskId, state: ACTIVE.includes(task.state) ? 'cancellation_requested' : task.state };
  });
}
async function confirmCancellation(runtime, taskId, body) {
  s.check(body?.confirmedStopped === true, 409, 'Confirm exact execution stoppage before acknowledging cancellation');
  return tx(async client => {
    const { task } = await lockTask(client, taskId, runtime);
    s.check(task.state === 'cancellation_requested', 409, 'Task cancellation is not pending');
    const running = await one(client, "SELECT action_id FROM shared_task_actions WHERE task_id=$1 AND outcome='running'", [taskId]);
    s.check(!running, 409, 'Retain the running action outcome before confirming cancellation');
    await client.query("UPDATE shared_tasks SET state='cancellation_confirmed',cancellation_confirmed_at=NOW(),completed_at=NOW() WHERE task_id=$1", [taskId]);
    await client.query("UPDATE shared_batches SET status='skipped',completed_at=NOW() WHERE task_id=$1", [taskId]);
    await client.query('UPDATE shared_runtimes SET execution_id=NULL,execution_kind=NULL,execution_started_at=NULL,execution_uncertain=FALSE WHERE agent_id=$1', [runtime.agentId]);
    return { taskId, state: 'cancellation_confirmed' };
  });
}
async function list(userId, roomId) {
  return tx(async client => {
    const room = await one(client, 'SELECT owner_id FROM shared_conversations WHERE id=$1 FOR UPDATE', [s.uuid(roomId)]);
    const member = await one(client, `SELECT user_id FROM shared_members WHERE conversation_id=$1 AND user_id=$2
      AND status='active' AND (expires_at IS NULL OR expires_at>NOW())`, [roomId, s.uuid(userId)]);
    s.check(room && member, 404, 'Shared conversation unavailable');
    const tasks = (await client.query(`SELECT t.task_id,t.requester_kind,t.requester_id,t.state,t.created_at,t.completed_at,t.cancellation_requested_at,
      t.cancellation_confirmed_at,t.result_held_at,t.current_authorization->>'state' AS authorization_state,d.device_label,d.executor_type FROM shared_tasks t
      LEFT JOIN agent_devices d ON d.device_id=t.device_id WHERE t.conversation_id=$1 ORDER BY t.created_at DESC LIMIT 30`, [roomId])).rows;
    for (const task of tasks) {
      task.actions = room.owner_id === userId ? (await client.query('SELECT * FROM shared_task_actions WHERE task_id=$1 ORDER BY created_at', [task.task_id])).rows.map(action =>
        ({ ...publicAction(action), parameters: action.action_payload.parameters })) : [];
      task.canCancel = room.owner_id === userId || task.requester_kind === 'user' && task.requester_id === userId;
    }
    return tasks;
  });
}
async function listGuest(credentials, roomId) {
  return tx(async client => {
    const access = await require('./guestService').currentGuestAccessInTransaction(client,
      credentials.sessionId, credentials.sessionTokenHash, s.uuid(roomId));
    return (await client.query(`SELECT t.task_id,t.requester_kind,t.requester_id,t.state,t.created_at,t.completed_at,
      t.cancellation_requested_at,t.cancellation_confirmed_at,t.current_authorization->>'state' AS authorization_state,d.device_label,d.executor_type FROM shared_tasks t
      LEFT JOIN agent_devices d ON d.device_id=t.device_id WHERE t.conversation_id=$1 ORDER BY t.created_at DESC LIMIT 30`, [roomId])).rows.map(task => ({
      ...task, actions: [], canCancel: task.requester_kind === 'guest' && task.requester_id === access.guest.guest_id
    }));
  });
}
async function heldResult(userId, taskId) {
  const task = await one(db, `SELECT t.held_result,t.result_held_at FROM shared_tasks t JOIN shared_conversations sc ON sc.id=t.conversation_id
    WHERE t.task_id=$1 AND sc.owner_id=$2`, [s.uuid(taskId), s.uuid(userId)]);
  s.check(task, 404, 'Held result unavailable');
  return task;
}
async function invalidateAuthority({ grantId = null, revision = null, deviceId = null, epoch = null }) {
  const schema = await one(db, `SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='shared_tasks' AND column_name='cancellation_requested_at'`);
  if (!schema) return;
  const candidates = (await db.query(`SELECT task_id FROM shared_tasks
    WHERE ($1::uuid IS NOT NULL AND grant_id=$1 AND grant_revision<$2)
       OR ($3::uuid IS NOT NULL AND device_id=$3 AND device_epoch<$4)
    ORDER BY conversation_id,task_id`, [grantId, revision, deviceId, epoch])).rows;
  // Policy rows are already committed. Never take task/room locks while holding
  // a grant/device mutation lock: action authorization uses the opposite order.
  for (const candidate of candidates) await tx(async client => {
    const { task } = await lockTask(client, candidate.task_id);
    if (grantId && task.grant_id === grantId && Number(task.grant_revision) < revision ||
        deviceId && task.device_id === deviceId && Number(task.device_epoch) < epoch)
      await revokePending(client, task, 'Execution permissions changed');
  });
}
module.exports = { authorize, propose, decide, start, complete, cancel, confirmCancellation, list, listGuest, heldResult, invalidateAuthority, canonical, descriptor, digest };
