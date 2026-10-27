'use strict';

const crypto = require('crypto');
const { getClient, query } = require('../db/connection');
const { BriefError, DEFAULT_DOCUMENT, DEFAULT_POLICY, contextForSnapshot } = require('./agentBriefService');

const LEASE_MS = 2 * 60 * 60 * 1000;
const MANUAL_ONCE_MS = 5 * 60 * 1000;
const USER_INACTIVITY_MS = 24 * 60 * 60 * 1000;
const OUTCOMES = new Set(['progress', 'no_progress', 'waiting_user', 'blocked', 'ready_for_review', 'sleep_until', 'wait_event', 'unknown']);

async function withAgentLock(agentId, callback) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO agent_briefs (agent_id, document, policy)
      VALUES ($1,$2::jsonb,$3::jsonb) ON CONFLICT (agent_id) DO NOTHING`, [agentId, JSON.stringify(DEFAULT_DOCUMENT), JSON.stringify(DEFAULT_POLICY)]);
    const row = (await client.query('SELECT revision, document, policy, state FROM agent_briefs WHERE agent_id=$1 FOR UPDATE', [agentId])).rows[0];
    const result = await callback(client, row);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function writeState(client, agentId, state) {
  await client.query('UPDATE agent_briefs SET state=$2::jsonb WHERE agent_id=$1', [agentId, JSON.stringify(state)]);
}

async function activity(client, agentId, eventType, detail = {}) {
  await client.query('INSERT INTO agent_brief_activity (agent_id,event_type,detail) VALUES ($1,$2,$3::jsonb)', [agentId, eventType, JSON.stringify(detail)]);
}

async function claimWake(agentId, { now = new Date() } = {}) {
  if (process.env.FEATURE_AGENT_PROACTIVE === 'false') return { admitted: false, reason: 'disabled_by_operator' };
  return withAgentLock(agentId, async (client, row) => {
    const state = { ...(row.state || {}), supportsProactive: true };
    const policy = row.policy || DEFAULT_POLICY;
    const last = (await client.query(`SELECT run_id, lease_expires_at FROM agent_brief_wakes
      WHERE agent_id=$1 AND status='admitted' ORDER BY admitted_at DESC LIMIT 1`, [agentId])).rows[0];
    if (last && new Date(last.lease_expires_at).getTime() <= now.getTime()) {
      await client.query(`UPDATE agent_brief_wakes SET status='unknown', outcome='unknown', finished_at=NOW()::timestamp WHERE run_id=$1`, [last.run_id]);
      state.status = 'needs_review'; state.nextWakeAt = null; state.activeRunId = null;
      await activity(client, agentId, 'outcome_unknown', { runId: last.run_id, reason: 'The runner stopped before confirming the outcome. No retry was admitted.' });
    } else if (last) {
      await writeState(client, agentId, state);
      return { admitted: false, reason: 'run_in_progress' };
    }
    const manual = state.manualOnce === true && Date.parse(state.manualOnceExpiresAt || '') > now.getTime();
    if (state.manualOnce && !manual) { state.manualOnce = false; state.manualOnceExpiresAt = null; }
    const automatic = policy.enabled === true && policy.paused !== true;
    const skip = async reason => { await writeState(client, agentId, state); return { admitted: false, reason }; };
    if (!manual && !automatic) return skip(policy.paused ? 'paused' : 'off');
    if (!manual && ['waiting_user', 'blocked', 'ready_for_review', 'waiting_event', 'needs_review'].includes(state.status)) return skip(state.status);
    // A timed sleep becomes eligible when due. A sleep without a time needs an
    // explicit owner action, so polling cannot turn it into a busy loop.
    if (!manual && state.status === 'sleeping' && !state.nextWakeAt) return skip('sleeping');
    if (!manual && Date.parse(policy.expiresAt || '') <= now.getTime()) { state.status = 'expired'; state.nextWakeAt = null; await activity(client, agentId, 'authorization_expired'); return skip('expired'); }
    if (!manual && Number(state.usedRuns || 0) >= Number(policy.maxRuns || 0)) { state.status = 'allowance_exhausted'; state.nextWakeAt = null; return skip('allowance_exhausted'); }
    if (!manual && now.getTime() - Date.parse(state.lastDirectUserAt || state.enabledAt || 0) >= USER_INACTIVITY_MS) { state.status = 'user_inactive'; state.nextWakeAt = null; await activity(client, agentId, 'user_inactive'); return skip('user_inactive'); }
    if (!manual && Date.parse(state.nextWakeAt || '') > now.getTime()) return skip('not_due');
    if (!manual && policy.goalId !== row.document?.activeGoalId) { state.status = 'goal_mismatch'; state.nextWakeAt = null; return skip('goal_mismatch'); }
    const activeGoal = row.document?.goals?.find(g => g.id === (manual ? row.document.activeGoalId : policy.goalId));
    if (!activeGoal || activeGoal.status !== 'in_progress') { state.status = 'goal_unavailable'; state.nextWakeAt = null; return skip('goal_unavailable'); }
    const unread = await client.query('SELECT COUNT(*)::int AS count FROM user_messages WHERE agent_id=$1 AND read_at IS NULL', [agentId]);
    if (Number(unread.rows[0]?.count || 0) > 0) return skip('user_messages_first');
    const runId = crypto.randomUUID();
    const trigger = manual ? 'check_once' : 'periodic';
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    await client.query(`INSERT INTO agent_brief_wakes (run_id,agent_id,brief_revision,trigger_type,policy_snapshot,lease_expires_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [runId, agentId, row.revision, trigger, JSON.stringify(policy), leaseExpiresAt]);
    state.manualOnce = false; state.manualOnceExpiresAt = null;
    state.activeRunId = runId; state.status = 'working'; state.nextWakeAt = null;
    if (!manual) state.usedRuns = Number(state.usedRuns || 0) + 1;
    await writeState(client, agentId, state);
    await activity(client, agentId, 'run_admitted', { runId, trigger, revision: row.revision, remainingRuns: manual ? null : Math.max(0, policy.maxRuns - state.usedRuns) });
    return { admitted: true, runId, trigger, briefRevision: row.revision, remainingRuns: manual ? null : Math.max(0, policy.maxRuns - state.usedRuns),
      prompt: `${contextForSnapshot({ revision: row.revision, document: row.document, policy }, trigger === 'check_once' ? 'Owner requested one check' : 'Approved periodic check')}\nAutomatic run ${runId}. Report one structured outcome with message_helper.py wake-outcome before finishing. Work only toward the active goal. Stop if no useful action exists.` };
  });
}

async function completeWake(agentId, runId, { outcome = 'unknown', reason = '', sleepUntil = null } = {}) {
  if (!OUTCOMES.has(outcome)) throw new BriefError('Invalid automatic run outcome');
  if (typeof reason !== 'string' || reason.length > 500) throw new BriefError('Outcome reason must be at most 500 characters');
  if (sleepUntil && (!Number.isFinite(Date.parse(sleepUntil)) || Date.parse(sleepUntil) <= Date.now())) throw new BriefError('Sleep time must be in the future');
  return withAgentLock(agentId, async (client, row) => {
    const run = (await client.query('SELECT run_id, status, trigger_type FROM agent_brief_wakes WHERE run_id=$1 AND agent_id=$2 FOR UPDATE', [runId, agentId])).rows[0];
    if (!run) throw new BriefError('Automatic run not found', 404, 'RUN_NOT_FOUND');
    if (run.status !== 'admitted') return { completed: false, status: run.status };
    const state = { ...(row.state || {}) };
    const policy = row.policy || DEFAULT_POLICY;
    if (outcome === 'sleep_until') {
      if (!sleepUntil || Date.parse(sleepUntil) < Date.now() + Number(policy.intervalMinutes || 30) * 60_000 ||
          (policy.expiresAt && Date.parse(sleepUntil) > Date.parse(policy.expiresAt))) {
        throw new BriefError('Sleep time must be after the minimum interval and before policy expiry');
      }
    }
    await client.query(`UPDATE agent_brief_wakes SET status=$2, outcome=$3, reason=$4, finished_at=NOW()::timestamp WHERE run_id=$1`,
      [runId, outcome === 'unknown' ? 'unknown' : 'completed', outcome, reason]);
    state.activeRunId = null;
    const canRepeat = process.env.FEATURE_AGENT_PROACTIVE !== 'false' && run.trigger_type === 'periodic' && policy.enabled === true && policy.paused !== true && Date.parse(policy.expiresAt || '') > Date.now() && Number(state.usedRuns || 0) < Number(policy.maxRuns || 0);
    const next = delay => canRepeat ? new Date(Date.now() + delay).toISOString() : null;
    if (policy.paused) { state.status = 'paused'; state.nextWakeAt = null; }
    else if (outcome === 'progress') { state.unproductiveRuns = 0; state.status = canRepeat ? 'active' : 'stopped'; state.nextWakeAt = next(policy.intervalMinutes * 60_000); }
    else if (outcome === 'no_progress') { state.unproductiveRuns = Number(state.unproductiveRuns || 0) + 1; state.status = state.unproductiveRuns >= 2 ? 'sleeping' : canRepeat ? 'active' : 'stopped'; state.nextWakeAt = state.unproductiveRuns >= 2 ? null : next(policy.intervalMinutes * 2 * 60_000); }
    else if (outcome === 'sleep_until') { state.status = canRepeat ? 'sleeping' : 'stopped'; state.nextWakeAt = canRepeat && sleepUntil ? sleepUntil : null; }
    else { state.status = outcome === 'unknown' ? 'needs_review' : outcome === 'wait_event' ? 'waiting_event' : outcome; state.nextWakeAt = null; }
    if (!canRepeat && ['active', 'stopped'].includes(state.status)) state.status = policy.enabled && Number(state.usedRuns || 0) >= Number(policy.maxRuns || 0) ? 'allowance_exhausted' : 'stopped';
    await writeState(client, agentId, state);
    await activity(client, agentId, 'run_finished', { runId, outcome, reason, nextWakeAt: state.nextWakeAt });
    return { completed: true, status: state.status, nextWakeAt: state.nextWakeAt };
  });
}

async function requestCheckOnce(agentId) {
  if (process.env.FEATURE_AGENT_PROACTIVE === 'false') throw new BriefError('Automatic work is temporarily disabled', 503, 'WAKE_DISABLED');
  return withAgentLock(agentId, async (client, row) => {
    if (row.state?.supportsProactive !== true) throw new BriefError('This connection cannot wake automatically', 409, 'WAKE_UNAVAILABLE');
    const goal = row.document?.goals?.find(g => g.id === row.document.activeGoalId);
    if (!goal || goal.status !== 'in_progress') throw new BriefError('Choose an active goal in progress first');
    const state = { ...(row.state || {}), manualOnce: true, manualOnceExpiresAt: new Date(Date.now() + MANUAL_ONCE_MS).toISOString(), status: 'queued_once' };
    await writeState(client, agentId, state);
    await activity(client, agentId, 'check_once_requested');
    return { queued: true, expiresAt: state.manualOnceExpiresAt };
  });
}

async function recordDirectUserInteraction(agentId) {
  return withAgentLock(agentId, async (client, row) => {
    const state = { ...(row.state || {}), lastDirectUserAt: new Date().toISOString() };
    if (['waiting_user', 'user_inactive'].includes(state.status) && row.policy?.enabled && !row.policy?.paused && Date.parse(row.policy.expiresAt || '') > Date.now()) {
      state.status = 'active';
      state.nextWakeAt = new Date(Date.now() + row.policy.intervalMinutes * 60_000).toISOString();
    }
    await writeState(client, agentId, state);
  });
}

module.exports = { claimWake, completeWake, requestCheckOnce, recordDirectUserInteraction, OUTCOMES };
