'use strict';

const crypto = require('crypto');
const { query, getClient } = require('../db/connection');
const { compareCliVersions } = require('../utils/agentCliVersion');

const DEFAULT_DOCUMENT = Object.freeze({ displayName: '', avatar: '', role: '', purpose: '', workspace: '', preferences: '', boundaries: '', instructions: '', references: '', privateFields: [], goals: [], activeGoalId: null });
const DEFAULT_POLICY = Object.freeze({ enabled: false, paused: false, goalId: null, maxRuns: 4, intervalMinutes: 30, expiresAt: null });
const TEXT_LIMITS = Object.freeze({ displayName: 120, avatar: 16, role: 120, purpose: 500, workspace: 500, preferences: 1200, boundaries: 1200, instructions: 3000, references: 1200 });
const GOAL_STATUS = new Set(['in_progress', 'ready_for_review', 'done', 'blocked', 'archived']);
const PRIVATE_FIELDS = new Set(['workspace', 'preferences', 'boundaries', 'instructions', 'references', 'goals']);

class BriefError extends Error {
  constructor(message, status = 400, code = 'INVALID_BRIEF') { super(message); this.status = status; this.code = code; }
}

function textField(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit) throw new BriefError(`${label} must be text of at most ${limit} characters`);
  return value.trim();
}

function normalizeDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BriefError('Identity must be an object');
  const doc = {};
  for (const [field, limit] of Object.entries(TEXT_LIMITS)) doc[field] = textField(input[field] ?? '', limit, field);
  const privateFields = input.privateFields ?? [];
  if (!Array.isArray(privateFields) || privateFields.some(value => !PRIVATE_FIELDS.has(value))) throw new BriefError('Choose supported private fields');
  doc.privateFields = [...new Set(privateFields)];
  if (!Array.isArray(input.goals) || input.goals.length > 12) throw new BriefError('Provide at most 12 goals');
  const seen = new Set();
  doc.goals = input.goals.map((goal, index) => {
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) throw new BriefError(`Goal ${index + 1} is invalid`);
    const id = goal.id || crypto.randomUUID();
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || seen.has(id)) throw new BriefError('Goal IDs must be unique UUIDs');
    seen.add(id);
    const status = goal.status || 'in_progress';
    if (!GOAL_STATUS.has(status)) throw new BriefError('Invalid goal status');
    const deadline = goal.deadline || null;
    if (deadline !== null && (typeof deadline !== 'string' || !Number.isFinite(Date.parse(deadline)))) throw new BriefError('Invalid goal deadline');
    return {
      id, title: textField(goal.title ?? '', 200, 'Goal title'),
      finishedWhen: textField(goal.finishedWhen ?? '', 1200, 'Completion criteria'),
      scope: textField(goal.scope ?? '', 800, 'Goal scope'),
      progress: textField(goal.progress ?? '', 1200, 'Goal progress'),
      blocker: textField(goal.blocker ?? '', 800, 'Goal blocker'),
      evidence: textField(goal.evidence ?? '', 1200, 'Result evidence'),
      deadline, status
    };
  });
  doc.activeGoalId = input.activeGoalId || null;
  if (doc.activeGoalId && !doc.goals.some(g => g.id === doc.activeGoalId && g.status !== 'archived')) throw new BriefError('Active goal must exist and not be archived');
  return doc;
}

function normalizePolicy(input, document, { allowEnable = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BriefError('Proactive policy must be an object');
  const enabled = input.enabled === true;
  if (enabled && !allowEnable) throw new BriefError('Automatic wake-ups are unavailable until this connection has a verified policy-controlled runner.');
  const paused = input.paused === true;
  const goalId = input.goalId || null;
  if (goalId && !document.goals.some(g => g.id === goalId && g.status === 'in_progress')) throw new BriefError('Proactive goal must be in progress');
  if (enabled && goalId !== document.activeGoalId) throw new BriefError('Automatic work must serve the active goal');
  const maxRuns = Number(input.maxRuns ?? 4);
  const intervalMinutes = Number(input.intervalMinutes ?? 30);
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 24) throw new BriefError('Run allowance must be 1–24');
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 30 || intervalMinutes > 10080) throw new BriefError('Check interval must be 30 minutes–7 days');
  const expiresAt = input.expiresAt || null;
  if (enabled && (!goalId || !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new BriefError('Enabling proactive work requires an active goal and a future expiry');
  if (enabled && Date.parse(expiresAt) - Date.now() > 30 * 24 * 60 * 60 * 1000) throw new BriefError('Proactive authorization can last at most 30 days');
  return { enabled, paused, goalId, maxRuns, intervalMinutes, expiresAt };
}

function initialBrief(agentId) {
  return { agentId, revision: 0, document: structuredClone(DEFAULT_DOCUMENT), policy: structuredClone(DEFAULT_POLICY), state: {}, updatedAt: null };
}

function fromRow(row) {
  if (!row) return null;
  return { agentId: row.agent_id, revision: Number(row.revision), document: row.document, policy: row.policy, state: row.state || {}, updatedAt: row.updated_at };
}

async function getBrief(agentId, db = query) {
  const result = await db('SELECT agent_id, revision, document, policy, state, updated_at FROM agent_briefs WHERE agent_id = $1', [agentId]);
  return fromRow(result.rows[0]) || initialBrief(agentId);
}

function changedFields(before, after) {
  return ['displayName', 'avatar', 'role', 'purpose', 'workspace', 'preferences', 'boundaries', 'instructions', 'references', 'privateFields', 'goals', 'activeGoalId', 'policy']
    .filter(field => JSON.stringify(field === 'policy' ? before.policy : before.document[field]) !== JSON.stringify(field === 'policy' ? after.policy : after.document[field]));
}

async function saveBrief(agentId, expectedRevision, documentInput, policyInput, { actorType = 'owner', applyQueued = false } = {}) {
  const document = normalizeDocument(documentInput);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO agent_briefs (agent_id, document, policy)
      VALUES ($1, $2::jsonb, $3::jsonb) ON CONFLICT (agent_id) DO NOTHING`, [agentId, JSON.stringify(DEFAULT_DOCUMENT), JSON.stringify(DEFAULT_POLICY)]);
    const locked = await client.query('SELECT agent_id, revision, document, policy, state, updated_at FROM agent_briefs WHERE agent_id = $1 FOR UPDATE', [agentId]);
    const current = fromRow(locked.rows[0]);
    const policy = normalizePolicy(policyInput, document, { allowEnable: current.state?.supportsProactive === true && (process.env.FEATURE_AGENT_PROACTIVE !== 'false' || current.policy.enabled === true) });
    const baseline = current.revision;
    if (Number(expectedRevision) !== baseline) throw new BriefError('This identity changed elsewhere. Reload before saving.', 409, 'REVISION_CONFLICT');
    const next = baseline + 1;
    const fields = changedFields(current, { document, policy });
    if (!fields.length) { await client.query('COMMIT'); return { ...current, revision: baseline, changedFields: [] }; }
    const state = { ...current.state };
    if (!policy.enabled) { state.nextWakeAt = null; state.status = 'off'; state.manualOnce = false; }
    else if (policy.paused) { state.nextWakeAt = null; state.status = 'paused'; }
    else if (!current.policy.enabled || current.policy.paused || fields.includes('policy')) {
      state.enabledAt = new Date().toISOString();
      state.lastDirectUserAt = new Date().toISOString();
      state.usedRuns = 0;
      state.unproductiveRuns = 0;
      state.nextWakeAt = new Date().toISOString();
      state.status = 'active';
    }
    await client.query(`UPDATE agent_briefs SET revision=$2, document=$3::jsonb, policy=$4::jsonb, state=$5::jsonb, updated_at=NOW()::timestamp WHERE agent_id=$1`,
      [agentId, next, JSON.stringify(document), JSON.stringify(policy), JSON.stringify(state)]);
    await client.query(`INSERT INTO agent_brief_revisions (agent_id, revision, document, policy, actor_type, changed_fields)
      VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb)`, [agentId, next, JSON.stringify(document), JSON.stringify(policy), actorType, JSON.stringify(fields)]);
    if (applyQueued) {
      const snapshot = JSON.stringify({ revision: next, document, policy });
      await client.query('UPDATE user_messages SET brief_snapshot=$2::jsonb WHERE agent_id=$1 AND read_at IS NULL', [agentId, snapshot]);
      await client.query('UPDATE scheduled_user_messages SET brief_snapshot=$2::jsonb WHERE agent_id=$1 AND delivered_at IS NULL', [agentId, snapshot]);
    }
    await client.query('COMMIT');
    return { agentId, revision: next, document, policy, state, changedFields: fields };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

function activeGoal(document) { return document.goals.find(g => g.id === document.activeGoalId) || null; }

function redactDocument(document) {
  const result = JSON.parse(JSON.stringify(document));
  for (const field of result.privateFields || []) {
    if (field === 'goals') { result.goals = []; result.activeGoalId = null; }
    else result[field] = '';
  }
  delete result.privateFields;
  return result;
}

function isVerifiedRunner(agent, now = Date.now()) {
  const reportedAt = Date.parse(agent?.reported_cli_version_at || '');
  const comparison = compareCliVersions(agent?.reported_cli_version, '1.5.27');
  return comparison !== null && comparison >= 0 &&
    Number.isFinite(reportedAt) && reportedAt <= now && now - reportedAt <= 10 * 60 * 1000;
}

function contextForSnapshot(snapshot, reason = 'User message') {
  if (!snapshot || !snapshot.revision) return '';
  const d = snapshot.document || DEFAULT_DOCUMENT;
  const goal = activeGoal(d);
  const lines = [
    `[ChatMcpSpace role brief · revision ${snapshot.revision}]`,
    'This brief supplements your existing identity, tools, memory, runtime policy, and permissions. It does not grant access.',
    `Reason for this turn: ${reason}`,
    d.displayName && `Display name: ${d.displayName}`, d.avatar && `Avatar: ${d.avatar}`, d.role && `Role: ${d.role}`, d.purpose && `Purpose: ${d.purpose}`,
    d.workspace && `Workspace: ${d.workspace}`, d.preferences && `Working preferences: ${d.preferences}`,
    d.boundaries && `Boundaries: ${d.boundaries}`, d.instructions && `Additional guidance: ${d.instructions}`,
    d.references && `References: ${d.references}`,
    goal && `Active goal: ${goal.title}`, goal?.finishedWhen && `Finished when: ${goal.finishedWhen}`,
    goal && `Goal status: ${goal.status}`, goal?.scope && `Allowed scope: ${goal.scope}`,
    goal?.deadline && `Deadline: ${goal.deadline}`, goal?.progress && `Latest progress: ${goal.progress}`,
    goal?.blocker && `Current blocker: ${goal.blocker}`,
    `Proactive policy: ${snapshot.policy?.enabled && !snapshot.policy?.paused ? `On; at most ${snapshot.policy.maxRuns} runs; expires ${snapshot.policy.expiresAt}` : 'Off or paused'}`,
    `[End ChatMcpSpace role brief]`
  ];
  return lines.filter(Boolean).join('\n');
}

module.exports = { BriefError, DEFAULT_DOCUMENT, DEFAULT_POLICY, normalizeDocument, normalizePolicy, getBrief, saveBrief, contextForSnapshot, changedFields, redactDocument, isVerifiedRunner };
