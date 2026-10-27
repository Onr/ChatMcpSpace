'use strict';

const express = require('express');
const { query } = require('../db/connection');
const { isValidUUID } = require('../utils/validation');
const { BriefError, getBrief, saveBrief, normalizeDocument, redactDocument, isVerifiedRunner } = require('../services/agentBriefService');
const { requestCheckOnce } = require('../services/agentProactiveService');

const router = express.Router();

router.post('/brief/pause-all', async (req, res) => {
  try {
    const agents = await query(`SELECT b.agent_id, b.policy FROM agent_briefs b JOIN agents a ON a.agent_id=b.agent_id
      WHERE a.user_id=$1`, [req.user.userId]);
    let paused = 0;
    for (const row of agents.rows.filter(item => item.policy?.enabled && !item.policy?.paused)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const current = await getBrief(row.agent_id);
          if (!current.policy.enabled || current.policy.paused) break;
          await saveBrief(row.agent_id, current.revision, current.document, { ...current.policy, paused: true });
          paused += 1;
          break;
        } catch (error) { if (error.code !== 'REVISION_CONFLICT' || attempt === 1) throw error; }
      }
    }
    return res.json({ paused });
  } catch (error) { return fail(res, error); }
});

function fail(res, error) {
  if (error instanceof BriefError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  console.error('Agent brief error:', error);
  return res.status(500).json({ error: { message: 'Unable to update agent identity' } });
}

async function viewable(req, res, next) {
  if (!isValidUUID(req.params.agentId)) return res.status(400).json({ error: { message: 'Invalid agent ID' } });
  try {
    const result = await query('SELECT agent_id, agent_name, reported_cli_version, reported_cli_version_at FROM agents WHERE agent_id=$1 AND user_id=$2', [req.params.agentId, req.user.userId]);
    if (result.rows.length) { req.briefAgent = result.rows[0]; req.briefAccess = 'owner'; return next(); }
    let shared;
    try {
      shared = await query(`SELECT a.agent_id, a.agent_name, a.reported_cli_version, a.reported_cli_version_at, m.role FROM shared_conversations c
        JOIN shared_members m ON m.conversation_id=c.id AND m.user_id=$2 AND m.status='active'
        JOIN agents a ON a.agent_id=c.agent_id WHERE c.agent_id=$1 AND m.role IN ('manager','participant') LIMIT 1`,
        [req.params.agentId, req.user.userId]);
    } catch (error) { if (error.code === '42P01' || /shared_conversations.*(does not exist|not found)|relation.*shared_conversations/i.test(error.message || '')) return res.status(404).json({ error: { message: 'Agent not found' } }); throw error; }
    if (!shared.rows.length) return res.status(404).json({ error: { message: 'Agent not found' } });
    req.briefAgent = shared.rows[0];
    req.briefAccess = shared.rows[0].role;
    return next();
  } catch (error) { return fail(res, error); }
}

function owned(req, res, next) {
  return viewable(req, res, () => req.briefAccess === 'owner' ? next() : res.status(404).json({ error: { message: 'Agent not found' } }));
}

router.get('/:agentId/brief', viewable, async (req, res) => {
  try {
    const brief = await getBrief(req.params.agentId);
    const suggestions = req.briefAccess === 'owner' ? await query(`SELECT suggestion_id, base_revision, proposed_document, reason, created_at
      FROM agent_brief_suggestions WHERE agent_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 20`, [req.params.agentId]) : { rows: [] };
    return res.json({ ...brief, proactiveAvailable: process.env.FEATURE_AGENT_PROACTIVE !== 'false' && brief.state?.supportsProactive === true && isVerifiedRunner(req.briefAgent),
      document: req.briefAccess === 'owner' ? brief.document : redactDocument(brief.document),
      agentName: req.briefAgent.agent_name, suggestions: suggestions.rows,
      permissions: { editIdentity: req.briefAccess === 'owner', editGoals: req.briefAccess !== 'participant' && !(brief.document.privateFields || []).includes('goals'), editPolicy: req.briefAccess === 'owner', pause: req.briefAccess !== 'participant', history: req.briefAccess !== 'participant' } });
  } catch (error) { return fail(res, error); }
});

router.put('/:agentId/brief', viewable, async (req, res) => {
  try {
    if (!Number.isInteger(req.body?.expectedRevision)) throw new BriefError('Expected revision is required');
    if (req.briefAccess === 'participant') return res.status(403).json({ error: { message: 'View-only collaborators cannot edit this identity' } });
    let document = req.body.document;
    let policy = req.body.policy;
    if (req.briefAccess === 'manager') {
      const current = await getBrief(req.params.agentId);
      if ((current.document.privateFields || []).includes('goals')) throw new BriefError('The owner has made these goals private', 403);
      document = { ...current.document, goals: req.body?.document?.goals, activeGoalId: req.body?.document?.activeGoalId };
      const proposedPolicy = req.body?.policy || current.policy;
      for (const key of Object.keys(current.policy)) if (key !== 'paused' && JSON.stringify(proposedPolicy[key]) !== JSON.stringify(current.policy[key])) throw new BriefError('Collaborators cannot change proactive limits', 403);
      if (proposedPolicy.paused === false && current.policy.paused === true) throw new BriefError('Only the owner can resume automatic work', 403);
      policy = { ...current.policy, paused: proposedPolicy.paused === true || current.policy.paused === true };
    }
    if (req.briefAccess === 'owner' && policy?.enabled === true && policy.paused !== true && !isVerifiedRunner(req.briefAgent)) {
      const currentPolicy = (await getBrief(req.params.agentId)).policy;
      if (!currentPolicy.enabled || currentPolicy.paused || JSON.stringify(currentPolicy) !== JSON.stringify(policy)) {
        throw new BriefError('A current policy-controlled local runner is required to enable or renew automatic work', 409, 'WAKE_UNAVAILABLE');
      }
    }
    if (req.briefAccess === 'owner' && policy?.enabled === true) {
      const lineage = await query('SELECT parent_agent_id FROM agents WHERE agent_id=$1', [req.params.agentId]);
      if (lineage.rows[0]?.parent_agent_id) throw new BriefError('Automatic work for delegated agents requires parent allowance support, which is unavailable for this connection.');
    }
    const brief = await saveBrief(req.params.agentId, req.body.expectedRevision, document, policy, { actorType: req.briefAccess === 'manager' ? 'collaborator' : 'owner', applyQueued: req.briefAccess === 'owner' && req.body.applyQueued === true });
    return res.json({ ...brief, document: req.briefAccess === 'owner' ? brief.document : redactDocument(brief.document), notice: `Agent will use revision ${brief.revision} from its next turn.` });
  } catch (error) { return fail(res, error); }
});

router.post('/:agentId/brief/check-once', owned, async (req, res) => {
  try {
    if (!isVerifiedRunner(req.briefAgent)) throw new BriefError('A current policy-controlled local runner is required', 409, 'WAKE_UNAVAILABLE');
    return res.json(await requestCheckOnce(req.params.agentId));
  }
  catch (error) { return fail(res, error); }
});

router.get('/:agentId/brief/history', viewable, async (req, res) => {
  try {
    if (req.briefAccess === 'participant') return res.status(403).json({ error: { message: 'History is not shared with view-only collaborators' } });
    const result = await query(`SELECT revision, document, policy, actor_type, changed_fields, created_at
      FROM agent_brief_revisions WHERE agent_id=$1 ORDER BY revision DESC LIMIT 100`, [req.params.agentId]);
    return res.json({ revisions: req.briefAccess === 'owner' ? result.rows : result.rows.map(row => ({ ...row, document: redactDocument(row.document) })) });
  } catch (error) { return fail(res, error); }
});

router.get('/:agentId/brief/queued', owned, async (req, res) => {
  try {
    const result = await query('SELECT COUNT(*)::int AS count FROM user_messages WHERE agent_id=$1 AND read_at IS NULL', [req.params.agentId]);
    const scheduled = await query('SELECT COUNT(*)::int AS count FROM scheduled_user_messages WHERE agent_id=$1 AND delivered_at IS NULL', [req.params.agentId]);
    return res.json({ pendingCount: Number(result.rows[0]?.count || 0) + Number(scheduled.rows[0]?.count || 0) });
  } catch (error) { return fail(res, error); }
});

router.post('/:agentId/brief/restore', owned, async (req, res) => {
  try {
    if (!Number.isInteger(req.body?.revision) || !Number.isInteger(req.body?.expectedRevision)) throw new BriefError('Revision is required');
    const old = await query('SELECT document, policy FROM agent_brief_revisions WHERE agent_id=$1 AND revision=$2', [req.params.agentId, req.body.revision]);
    if (!old.rows.length) return res.status(404).json({ error: { message: 'Revision not found' } });
    // Restoring text never silently reauthorizes automatic work.
    const policy = { ...old.rows[0].policy, enabled: false, paused: true };
    const brief = await saveBrief(req.params.agentId, req.body.expectedRevision, old.rows[0].document, policy, { actorType: 'restore' });
    return res.json({ ...brief, notice: `Restored as revision ${brief.revision}. Proactive work is paused.` });
  } catch (error) { return fail(res, error); }
});

router.post('/:agentId/brief/suggestions/:suggestionId/decision', owned, async (req, res) => {
  try {
    if (!isValidUUID(req.params.suggestionId) || !['accept', 'reject'].includes(req.body?.decision)) throw new BriefError('Choose accept or reject');
    const result = await query(`SELECT suggestion_id, base_revision, proposed_document FROM agent_brief_suggestions
      WHERE agent_id=$1 AND suggestion_id=$2 AND status='pending'`, [req.params.agentId, req.params.suggestionId]);
    if (!result.rows.length) return res.status(404).json({ error: { message: 'Suggestion not found' } });
    let brief = null;
    if (req.body.decision === 'accept') {
      const current = await getBrief(req.params.agentId);
      if (current.revision !== result.rows[0].base_revision) throw new BriefError('Identity changed since this suggestion. Review it against the latest version.', 409, 'REVISION_CONFLICT');
      brief = await saveBrief(req.params.agentId, current.revision,
        normalizeDocument(req.body.document || result.rows[0].proposed_document), current.policy,
        { applyQueued: req.body.applyQueued === true });
    }
    await query(`UPDATE agent_brief_suggestions SET status=$3, decided_at=NOW()::timestamp
      WHERE agent_id=$1 AND suggestion_id=$2 AND status='pending'`, [req.params.agentId, req.params.suggestionId, req.body.decision === 'accept' ? 'accepted' : 'rejected']);
    return res.json({ decided: true, brief });
  } catch (error) { return fail(res, error); }
});

router.get('/:agentId/brief/activity', viewable, async (req, res) => {
  try {
    if (req.briefAccess === 'participant') return res.status(403).json({ error: { message: 'Activity details are not shared with view-only collaborators' } });
    const result = await query(`SELECT event_type, detail, created_at FROM agent_brief_activity
      WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.params.agentId]);
    return res.json({ activity: req.briefAccess === 'owner' ? result.rows : result.rows.map(row => ({ ...row, detail: { outcome: row.detail?.outcome || null } })) });
  } catch (error) { return fail(res, error); }
});

module.exports = router;
