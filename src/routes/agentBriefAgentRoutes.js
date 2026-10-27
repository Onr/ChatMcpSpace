'use strict';

const express = require('express');
const { query } = require('../db/connection');
const { getBrief, normalizeDocument, BriefError, contextForSnapshot, isVerifiedRunner } = require('../services/agentBriefService');
const { claimWake, completeWake } = require('../services/agentProactiveService');

const router = express.Router();

async function agentForRequest(req, res, next) {
  try {
    const name = String(req.query.agentName || req.body?.agentName || req.headers['x-agent-name'] || '').trim();
    if (!name || name.length > 255) return res.status(400).json({ error: { message: 'Agent name is required' } });
    const rows = await query('SELECT agent_id, agent_name, reported_cli_version, reported_cli_version_at FROM agents WHERE user_id=$1 AND agent_name=$2', [req.user.userId, name]);
    if (!rows.rows.length) return res.status(404).json({ error: { message: 'Agent not found' } });
    if (req.authContext?.type === 'agent_token' && req.authContext.agentId !== rows.rows[0].agent_id) return res.status(403).json({ error: { message: 'Agent credential cannot access this identity' } });
    req.briefAgent = rows.rows[0];
    return next();
  } catch (error) { console.error('Agent brief lookup:', error); return res.status(500).json({ error: { message: 'Unable to load identity' } }); }
}

router.get('/', agentForRequest, async (req, res) => {
  try {
    const brief = await getBrief(req.briefAgent.agent_id);
    return res.json({ revision: brief.revision, document: brief.document, policy: brief.policy,
      context: contextForSnapshot(brief, 'Next assigned turn') });
  } catch (error) { return res.status(500).json({ error: { message: 'Unable to load identity' } }); }
});

router.post('/wake/claim', agentForRequest, async (req, res) => {
  try {
    if (!isVerifiedRunner(req.briefAgent)) throw new BriefError('A current policy-controlled local runner is required', 409, 'WAKE_UNAVAILABLE');
    return res.json(await claimWake(req.briefAgent.agent_id));
  }
  catch (error) { console.error('Automatic wake claim:', error); return res.status(error.status || 500).json({ error: { message: error.status ? error.message : 'Unable to claim wake-up' } }); }
});

router.post('/wake/:runId/outcome', agentForRequest, async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.runId)) throw new BriefError('Invalid run ID');
    return res.json(await completeWake(req.briefAgent.agent_id, req.params.runId, req.body || {}));
  } catch (error) { return res.status(error.status || 500).json({ error: { message: error.status ? error.message : 'Unable to record outcome' } }); }
});

router.post('/suggestions', agentForRequest, async (req, res) => {
  try {
    const current = await getBrief(req.briefAgent.agent_id);
    const next = normalizeDocument(req.body?.document);
    if (JSON.stringify(next.privateFields) !== JSON.stringify(current.document.privateFields || [])) throw new BriefError('Agents cannot change field visibility');
    for (const key of ['displayName', 'avatar', 'workspace', 'boundaries', 'instructions', 'references']) {
      if (next[key] !== current.document[key]) throw new BriefError(`Agents cannot propose changes to ${key}`);
    }
    if (next.goals.some((goal, index) => {
      const old = current.document.goals.find(item => item.id === goal.id);
      return old && (goal.scope !== old.scope || (goal.status === 'done' && old.status !== 'ready_for_review'));
    })) throw new BriefError('Agents can suggest goal details, but cannot expand scope or mark work done');
    const reason = String(req.body?.reason || '').trim();
    if (!reason || reason.length > 500) throw new BriefError('A short reason is required');
    const result = await query(`INSERT INTO agent_brief_suggestions (agent_id, base_revision, proposed_document, reason)
      VALUES ($1,$2,$3::jsonb,$4) RETURNING suggestion_id`, [req.briefAgent.agent_id, current.revision, JSON.stringify(next), reason]);
    return res.status(201).json({ suggestionId: result.rows[0].suggestion_id, status: 'pending' });
  } catch (error) {
    if (error instanceof BriefError) return res.status(error.status).json({ error: { message: error.message } });
    console.error('Agent brief suggestion:', error);
    return res.status(500).json({ error: { message: 'Unable to submit suggestion' } });
  }
});

module.exports = router;
