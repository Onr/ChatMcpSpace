/**
 * Chief of Staff Only Middleware
 *
 * Gates a route family to a user's privileged Chief of Staff agent.
 *
 * Must run AFTER `requireApiKey` (which sets `req.user`). Resolves the
 * acting agent from the `X-Agent-Name` header and rejects the request
 * unless `agents.is_chief_of_staff = TRUE`. On success, attaches:
 *   req.cosAgent = { agentId, agentName, userId }
 */

const { query } = require('../db/connection');

// Short-lived in-process cache of (userId, agentName) -> { agent, expiresAt }.
// CoS endpoints run on a hot path (heartbeat-driven roster polling) and the
// lookup is read-only, so a small TTL avoids a DB round-trip per request
// while still picking up CoS flag/name changes quickly.
const COS_CACHE_TTL_MS = 30 * 1000;
const cosLookupCache = new Map();

function makeCacheKey(userId, agentName) {
  return `${userId}::${agentName}`;
}

function getCachedAgent(userId, agentName) {
  const entry = cosLookupCache.get(makeCacheKey(userId, agentName));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cosLookupCache.delete(makeCacheKey(userId, agentName));
    return null;
  }
  return entry.agent;
}

function setCachedAgent(userId, agentName, agent) {
  cosLookupCache.set(makeCacheKey(userId, agentName), {
    agent,
    expiresAt: Date.now() + COS_CACHE_TTL_MS
  });
}

function invalidateCosCacheFor(userId, agentName) {
  if (userId && agentName) {
    cosLookupCache.delete(makeCacheKey(userId, agentName));
  } else if (userId) {
    for (const key of cosLookupCache.keys()) {
      if (key.startsWith(`${userId}::`)) cosLookupCache.delete(key);
    }
  } else {
    cosLookupCache.clear();
  }
}

async function chiefOfStaffOnly(req, res, next) {
  try {
    const agentName = req.headers['x-agent-name'];
    if (!agentName || typeof agentName !== 'string' || !agentName.trim()) {
      return res.status(400).json({
        error: {
          code: 'COS_AGENT_NAME_REQUIRED',
          message: 'X-Agent-Name header is required to identify the calling agent'
        }
      });
    }

    const trimmedName = agentName.trim();
    let agent = getCachedAgent(req.user.userId, trimmedName);

    if (!agent) {
      const result = await query(
        `SELECT agent_id, agent_name, is_chief_of_staff
         FROM agents
         WHERE user_id = $1 AND agent_name = $2`,
        [req.user.userId, trimmedName]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'COS_AGENT_NOT_FOUND',
            message: `Agent "${agentName}" not found for this user`
          }
        });
      }

      agent = result.rows[0];
      setCachedAgent(req.user.userId, trimmedName, agent);
    }

    if (!agent.is_chief_of_staff) {
      return res.status(403).json({
        error: {
          code: 'COS_FORBIDDEN',
          message: 'This endpoint is restricted to the Chief of Staff agent'
        }
      });
    }

    req.cosAgent = {
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      userId: req.user.userId
    };

    next();
  } catch (error) {
    console.error('chiefOfStaffOnly middleware error:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Authorization check failed' }
    });
  }
}

module.exports = { chiefOfStaffOnly, invalidateCosCacheFor };
