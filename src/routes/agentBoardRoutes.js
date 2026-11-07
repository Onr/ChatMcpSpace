'use strict';

const express = require('express');
const { query } = require('../db/connection');
const { StatusError, publishStatus, clearStatus, readBoard } = require('../services/agentBoardService');

const router = express.Router();

function fail(res, error, action) {
  if (error instanceof StatusError) return res.status(error.status).json({ error: { message: error.message } });
  console.error(`Agent board ${action}:`, error);
  return res.status(500).json({ error: { message: `Unable to ${action}` } });
}

// Agents only ever write their own status: scoped tokens are already bound to
// one identity by requireApiKey, and account keys name the identity they act as.
async function callingAgent(req, res, next) {
  try {
    const name = String(req.headers['x-agent-name'] || '').trim();
    if (!name || name.length > 255) return res.status(400).json({ error: { message: 'X-Agent-Name header is required' } });
    const agent = (await query('SELECT agent_id, agent_name FROM agents WHERE user_id=$1 AND agent_name=$2', [req.user.userId, name])).rows[0];
    if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });
    req.boardAgent = agent;
    return next();
  } catch (error) { return fail(res, error, 'load agent'); }
}

router.get('/', callingAgent, async (req, res) => {
  try {
    const agentName = typeof req.query.agent === 'string' ? req.query.agent.trim() : '';
    const board = await readBoard(req.user.userId, req.boardAgent.agent_name, agentName);
    if (agentName && !board.agents.length) return res.status(404).json({ error: { message: 'That agent is not on your board' } });
    return res.json(board);
  } catch (error) { return fail(res, error, 'read the board'); }
});

router.put('/status', callingAgent, async (req, res) => {
  try {
    return res.json({ status: await publishStatus(req.boardAgent.agent_id, req.body) });
  } catch (error) { return fail(res, error, 'publish status'); }
});

router.delete('/status', callingAgent, async (req, res) => {
  try {
    await clearStatus(req.boardAgent.agent_id);
    return res.json({ status: null });
  } catch (error) { return fail(res, error, 'clear status'); }
});

module.exports = router;
