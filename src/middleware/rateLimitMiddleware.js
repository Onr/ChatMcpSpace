/**
 * Rate Limiting Middleware
 * Implements rate limiting for different types of routes
 */

const { logRateLimitViolation } = require('../utils/securityLogger');
const { rateLimitRedisClient } = require('../utils/redisClient');
const os = require('os');

const ACTIVE_WINDOW_MS = Number(process.env.ADAPTIVE_RATE_ACTIVE_WINDOW_MS || 60_000);
const EVENT_LOOP_SAMPLE_MS = 1_000;
const EVENT_LOOP_STRESS_MS = Number(process.env.ADAPTIVE_RATE_EVENT_LOOP_STRESS_MS || 250);
const DEFAULT_MIN_POLL_INTERVAL_MS = Number(process.env.ADAPTIVE_RATE_MIN_POLL_INTERVAL_MS || 2_000);
const DEFAULT_MAX_POLL_INTERVAL_MS = Number(process.env.ADAPTIVE_RATE_MAX_POLL_INTERVAL_MS || 30_000);
const DEFAULT_POLL_JITTER_MS = Number(process.env.ADAPTIVE_RATE_POLL_JITTER_MS || 1_500);

// In-memory fallback store (used only if Redis is unavailable)
const fallbackStore = new Map();
const fallbackActiveSets = new Map();
const FALLBACK_TTL_MS = 60_000;
let eventLoopLagMs = 0;

const eventLoopInterval = setInterval(() => {
  const startedAt = Date.now();
  setTimeout(() => {
    eventLoopLagMs = Math.max(0, Date.now() - startedAt);
  }, 0).unref?.();
}, EVENT_LOOP_SAMPLE_MS);
if (typeof eventLoopInterval.unref === 'function') {
  eventLoopInterval.unref();
}

function cleanupFallbackStore() {
  const now = Date.now();
  for (const [key, data] of fallbackStore.entries()) {
    if (now - data.resetTime > FALLBACK_TTL_MS) {
      fallbackStore.delete(key);
    }
  }
  for (const [key, members] of fallbackActiveSets.entries()) {
    for (const [member, lastSeen] of members.entries()) {
      if (now - lastSeen > ACTIVE_WINDOW_MS) {
        members.delete(member);
      }
    }
    if (members.size === 0) {
      fallbackActiveSets.delete(key);
    }
  }
}

// Run cleanup every minute for fallback store
const fallbackCleanupInterval = setInterval(cleanupFallbackStore, FALLBACK_TTL_MS);
// Avoid keeping the process alive solely for cleanup (important for tests and graceful shutdown).
if (typeof fallbackCleanupInterval.unref === 'function') {
  fallbackCleanupInterval.unref();
}

async function incrementWithRedis(key, windowMs) {
  if (!rateLimitRedisClient || !rateLimitRedisClient.isReady) {
    return null;
  }

  try {
    const count = await rateLimitRedisClient.incr(key);
    if (count === 1) {
      await rateLimitRedisClient.pExpire(key, windowMs);
    }
    const ttl = await rateLimitRedisClient.pTTL(key);
    return { count, ttl };
  } catch (error) {
    console.error('[RateLimit] Redis error:', error.message);
    return null;
  }
}

function incrementFallback(key, windowMs) {
  const now = Date.now();
  let data = fallbackStore.get(key);

  if (!data || now - data.resetTime > windowMs) {
    data = { count: 0, resetTime: now };
    fallbackStore.set(key, data);
  }

  data.count += 1;
  return { count: data.count, ttl: windowMs - (now - data.resetTime) };
}

async function peekWithRedis(key) {
  if (!rateLimitRedisClient || !rateLimitRedisClient.isReady) {
    return null;
  }

  try {
    const [countStr, ttl] = await Promise.all([
      rateLimitRedisClient.get(key),
      rateLimitRedisClient.pTTL(key)
    ]);
    return { count: countStr ? parseInt(countStr, 10) || 0 : 0, ttl };
  } catch (error) {
    console.error('[RateLimit] Redis peek error:', error.message);
    return null;
  }
}

function peekFallback(key, windowMs) {
  const now = Date.now();
  const data = fallbackStore.get(key);
  if (!data || now - data.resetTime > windowMs) {
    return { count: 0, ttl: windowMs };
  }
  return { count: data.count, ttl: windowMs - (now - data.resetTime) };
}

/**
 * Resolve the same client identifier the middleware itself keys on, so
 * status-check endpoints read the exact counter a request would increment.
 */
function resolveClientIdentifier(req) {
  // Only authenticated middleware may establish a user identity. Public
  // callers must not be able to mint fresh quotas by rotating an arbitrary
  // credential-looking header.
  return (req.user && req.user.userId) || req.ip || 'unknown';
}

function resolveAgentName(req) {
  return (req.query && req.query.agentName)
    || (req.body && req.body.agentName)
    || req.headers['x-agent-name']
    || 'unknown';
}

/**
 * Read the current usage for a limiter without incrementing its counter or
 * registering the caller as "active" for adaptive fair-share purposes.
 * @param {Function} limiter - a middleware created by createRateLimiter
 */
async function getUsageStatus(limiter, { clientIdentifier, agentName } = {}) {
  const { windowMs, max, keyPrefix, perAgent, adaptive } = limiter.config;
  const identifier = clientIdentifier || 'unknown';
  const effectiveAgentName = perAgent ? (agentName || 'unknown') : null;
  const key = perAgent
    ? `${keyPrefix}:${identifier}:${effectiveAgentName}`
    : `${keyPrefix}:${identifier}`;

  const adaptiveState = await resolveAdaptiveLimit({
    keyPrefix,
    clientIdentifier: identifier,
    agentName: effectiveAgentName,
    max,
    adaptive,
    readOnly: true
  });
  const effectiveMax = adaptiveState.limit;

  const redisResult = await peekWithRedis(key);
  const result = redisResult || peekFallback(key, windowMs);
  const ttlMs = typeof result.ttl === 'number' && result.ttl > 0 ? result.ttl : windowMs;

  return {
    scope: keyPrefix,
    limit: effectiveMax,
    used: result.count,
    remaining: Math.max(0, effectiveMax - result.count),
    resetAt: new Date(Date.now() + ttlMs).toISOString(),
    windowMs,
    policy: adaptiveState.policy
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getServerCapacityFactor() {
  const cpuCount = Math.max(1, os.cpus().length || 1);
  const loadRatio = (os.loadavg()[0] || 0) / cpuCount;
  const memoryRatio = 1 - (os.freemem() / Math.max(1, os.totalmem()));
  const lagRatio = eventLoopLagMs / EVENT_LOOP_STRESS_MS;
  const stress = Math.max(loadRatio, memoryRatio, lagRatio);

  if (stress >= 1.5) return 0.35;
  if (stress >= 1.15) return 0.5;
  if (stress >= 0.9) return 0.75;
  if (stress <= 0.45) return 1.5;
  if (stress <= 0.65) return 1.2;
  return 1;
}

function getPollIntervalMs({ remaining, limit, retryAfterSeconds, minMs, maxMs }) {
  if (retryAfterSeconds) {
    return clamp(retryAfterSeconds * 1000, minMs, maxMs);
  }
  if (!limit || limit <= 0) return minMs;
  const remainingRatio = remaining / limit;
  if (remainingRatio <= 0.05) return clamp(minMs * 6, minMs, maxMs);
  if (remainingRatio <= 0.15) return clamp(minMs * 4, minMs, maxMs);
  if (remainingRatio <= 0.35) return clamp(minMs * 2, minMs, maxMs);
  return minMs;
}

function buildPollAdvice({ remaining, limit, retryAfterSeconds, minMs, maxMs, jitterMs, reason }) {
  return {
    nextPollMs: getPollIntervalMs({ remaining, limit, retryAfterSeconds, minMs, maxMs }),
    jitterMs: clamp(parsePositiveInt(jitterMs, DEFAULT_POLL_JITTER_MS), 0, maxMs),
    reason
  };
}

async function markActiveWithRedis(key, member, now, { readOnly = false } = {}) {
  if (!rateLimitRedisClient || !rateLimitRedisClient.isReady || !member) {
    return null;
  }

  try {
    if (!readOnly) {
      await rateLimitRedisClient.zAdd(key, [{ score: now, value: member }]);
    }
    await rateLimitRedisClient.zRemRangeByScore(key, 0, now - ACTIVE_WINDOW_MS);
    if (!readOnly) {
      await rateLimitRedisClient.pExpire(key, ACTIVE_WINDOW_MS * 2);
    }
    return await rateLimitRedisClient.zCard(key);
  } catch (error) {
    console.error('[RateLimit] Redis active-set error:', error.message);
    return null;
  }
}

function markActiveFallback(key, member, now, { readOnly = false } = {}) {
  if (!member) return 1;
  let members = fallbackActiveSets.get(key);
  if (!members) {
    if (readOnly) return 0;
    members = new Map();
    fallbackActiveSets.set(key, members);
  }
  if (!readOnly) {
    members.set(member, now);
  }
  for (const [existingMember, lastSeen] of members.entries()) {
    if (now - lastSeen > ACTIVE_WINDOW_MS) {
      members.delete(existingMember);
    }
  }
  return Math.max(readOnly ? 0 : 1, members.size);
}

async function getActiveCount(key, member, now, options = {}) {
  const redisCount = await markActiveWithRedis(key, member, now, options);
  if (typeof redisCount === 'number' && redisCount > 0) {
    return redisCount;
  }
  return markActiveFallback(key, member, now, options);
}

async function resolveAdaptiveLimit({
  keyPrefix,
  clientIdentifier,
  agentName,
  max,
  adaptive,
  readOnly = false
}) {
  if (!adaptive) {
    return {
      limit: max,
      policy: 'static',
      activeUsers: 1,
      activeAgents: agentName ? 1 : 0,
      capacityFactor: 1
    };
  }

  const now = Date.now();
  const capacityFactor = getServerCapacityFactor();
  const min = parsePositiveInt(adaptive.min, Math.max(3, Math.floor(max * 0.25)));
  const burstMax = parsePositiveInt(adaptive.max, Math.max(max, Math.ceil(max * 2)));
  const globalBase = parsePositiveInt(adaptive.globalMax, max);
  // Split the server's capacity first. burstMax caps each caller, not the
  // whole server; capping before division starves otherwise idle agents.
  const globalLimit = Math.max(min, Math.floor(globalBase * capacityFactor));
  const activeScope = adaptive.scope || keyPrefix;
  const activeUsers = await getActiveCount(`rl-active:${activeScope}:users`, String(clientIdentifier), now, { readOnly });
  let fairUserLimit = Math.max(min, Math.floor(globalLimit / Math.max(1, activeUsers)));
  let activeAgents = 0;

  if (agentName) {
    activeAgents = await getActiveCount(
      `rl-active:${activeScope}:agents:${clientIdentifier}`,
      String(agentName),
      now,
      { readOnly }
    );
    const minPerAgent = parsePositiveInt(adaptive.minPerAgent, Math.min(min, max));
    fairUserLimit = Math.max(minPerAgent, Math.floor(fairUserLimit / Math.max(1, activeAgents)));
  }

  return {
    limit: clamp(fairUserLimit, agentName ? parsePositiveInt(adaptive.minPerAgent, 1) : min, burstMax),
    policy: 'adaptive-fair-share',
    activeUsers,
    activeAgents,
    capacityFactor
  };
}

/**
 * Create a rate limiter middleware with specified options
 * @param {Object} options - Rate limiter configuration
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum number of requests per window
 * @param {string} options.message - Error message to return when limit exceeded
 * @param {string} options.keyPrefix - Prefix for the rate limit key
 * @param {boolean} options.perAgent - If true, include agent name in the key (for per-agent limits)
 * @param {Object|false} options.adaptive - Adaptive fair-share configuration
 * @returns {Function} Express middleware function
 */
function createRateLimiter(options) {
  const {
    windowMs = 60000, // Default: 1 minute
    max = 60, // Default: 60 requests per window
    message = 'Too many requests, please try again later',
    keyPrefix = 'rl',
    perAgent = false,
    adaptive = false,
    minPollIntervalMs = DEFAULT_MIN_POLL_INTERVAL_MS,
    maxPollIntervalMs = DEFAULT_MAX_POLL_INTERVAL_MS,
    pollJitterMs = DEFAULT_POLL_JITTER_MS
  } = options;

  const middleware = async function rateLimitMiddleware(req, res, next) {
    try {
      const clientIdentifier = resolveClientIdentifier(req);

      // For per-agent rate limiting, include agent name in the key
      let key = `${keyPrefix}:${clientIdentifier}`;
      if (perAgent) {
        const agentName = resolveAgentName(req);
        key = `${keyPrefix}:${clientIdentifier}:${agentName}`;
      }

      const agentNameForFairShare = perAgent ? resolveAgentName(req) : null;
      const adaptiveState = await resolveAdaptiveLimit({
        keyPrefix,
        clientIdentifier,
        agentName: agentNameForFairShare,
        max,
        adaptive
      });
      const effectiveMax = adaptiveState.limit;

      const redisResult = await incrementWithRedis(key, windowMs);
      const result = redisResult || incrementFallback(key, windowMs);

      const ttlMs = typeof result.ttl === 'number' && result.ttl > 0 ? result.ttl : windowMs;
      const resetTime = Date.now() + ttlMs;
      const remaining = Math.max(0, effectiveMax - result.count);

      res.setHeader('X-RateLimit-Limit', effectiveMax);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', new Date(resetTime).toISOString());
      res.setHeader('X-RateLimit-Policy', adaptiveState.policy);
      res.setHeader('X-RateLimit-Scope', keyPrefix);
      if (adaptiveState.policy === 'adaptive-fair-share') {
        res.setHeader('X-RateLimit-Active-Users', adaptiveState.activeUsers);
        if (adaptiveState.activeAgents) {
          res.setHeader('X-RateLimit-Active-Agents', adaptiveState.activeAgents);
        }
        res.setHeader('X-RateLimit-Capacity-Factor', adaptiveState.capacityFactor.toFixed(2));
      }

      if (result.count > effectiveMax) {
        logRateLimitViolation(req, keyPrefix);

        const retryAfterSeconds = Math.ceil(ttlMs / 1000);
        const pollAdvice = buildPollAdvice({
          remaining: 0,
          limit: effectiveMax,
          retryAfterSeconds,
          minMs: minPollIntervalMs,
          maxMs: maxPollIntervalMs,
          jitterMs: pollJitterMs,
          reason: 'rate_limited'
        });
        res.setHeader('Retry-After', retryAfterSeconds);
        res.setHeader('X-Poll-Interval-Ms', pollAdvice.nextPollMs);
        res.setHeader('X-Poll-Jitter-Ms', pollAdvice.jitterMs);
        res.locals.pollAdvice = pollAdvice;

        return res.status(429).json({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: message,
            retryAfter: retryAfterSeconds,
            limit: effectiveMax,
            policy: adaptiveState.policy
          },
          poll: pollAdvice
        });
      }

      const pollAdvice = buildPollAdvice({
        remaining,
        limit: effectiveMax,
        minMs: minPollIntervalMs,
        maxMs: maxPollIntervalMs,
        jitterMs: pollJitterMs,
        reason: remaining <= 0 ? 'limited' : 'ok'
      });
      res.setHeader('X-Poll-Interval-Ms', pollAdvice.nextPollMs);
      res.setHeader('X-Poll-Jitter-Ms', pollAdvice.jitterMs);
      res.locals.pollAdvice = pollAdvice;

      next();
    } catch (error) {
      console.error('[RateLimit] Middleware failure:', error.message);
      next();
    }
  };

  middleware.config = { windowMs, max, keyPrefix, perAgent, adaptive };
  return middleware;
}

/**
 * General rate limiter for all routes
 * 121 requests per minute per IP
 */
const generalRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 121,
  message: 'Too many requests from this IP, please try again later',
  keyPrefix: 'general'
});

/**
 * Strict rate limiter for authentication endpoints
 * 6 requests per minute per IP to prevent brute force attacks
 */
const authRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 6,
  message: 'Too many authentication attempts, please try again later',
  keyPrefix: 'auth'
});

/**
 * Rate limiter for user dashboard polling endpoints
 * 1065 requests per minute per session (raised slightly again for heavier multi-chat usage)
 */
const userPollingRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 1065,
  message: 'Too many requests, please slow down',
  keyPrefix: 'user-polling',
  adaptive: {
    scope: 'dashboard-polling',
    globalMax: parsePositiveInt(process.env.ADAPTIVE_USER_POLL_GLOBAL_MAX, 3200),
    min: parsePositiveInt(process.env.ADAPTIVE_USER_POLL_MIN, 180),
    max: parsePositiveInt(process.env.ADAPTIVE_USER_POLL_MAX, 1600)
  },
  minPollIntervalMs: 3000,
  maxPollIntervalMs: 30000
});

/**
 * Rate limiter for agent API polling endpoints (per agent)
 * 36 requests per minute per agent (poll every ~1.7 seconds max)
 * Each agent gets its own quota
 */
const agentPollingRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 36,
  message: 'Too many polling requests for this agent, please slow down',
  keyPrefix: 'agent-polling',
  perAgent: true,
  adaptive: {
    scope: 'agent-polling',
    globalMax: parsePositiveInt(process.env.ADAPTIVE_AGENT_POLL_GLOBAL_MAX, 1800),
    min: parsePositiveInt(process.env.ADAPTIVE_AGENT_POLL_USER_MIN, 24),
    minPerAgent: parsePositiveInt(process.env.ADAPTIVE_AGENT_POLL_MIN_PER_AGENT, 6),
    max: parsePositiveInt(process.env.ADAPTIVE_AGENT_POLL_MAX_PER_AGENT, 72)
  },
  minPollIntervalMs: 5000,
  maxPollIntervalMs: 60000
});

/**
 * Rate limiter for overall agent API usage per user
 * 455 requests per minute total across all agents
 */
const agentApiRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 455,
  message: 'Too many API requests, please try again later',
  keyPrefix: 'agent-api',
  adaptive: {
    scope: 'agent-api',
    globalMax: parsePositiveInt(process.env.ADAPTIVE_AGENT_API_GLOBAL_MAX, 4200),
    min: parsePositiveInt(process.env.ADAPTIVE_AGENT_API_USER_MIN, 120),
    max: parsePositiveInt(process.env.ADAPTIVE_AGENT_API_USER_MAX, 900)
  },
  minPollIntervalMs: 5000,
  maxPollIntervalMs: 60000
});

/**
 * Rate limiter for agent -> backend message ingestion (per agent)
 * 31 messages per minute per agent to guard against runaway/spam loops.
 * This is independent from per-user API limits.
 */
const agentMessageIngressRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 31,
  message: 'Too many messages from this agent, temporarily blocked to prevent spam',
  keyPrefix: 'agent-message-ingress',
  perAgent: true
});

/**
 * Rate limiter for feedback submissions
 * 6 requests per minute per IP to prevent spam
 */
const feedbackRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 6,
  message: 'Too many feedback submissions, please try again later',
  keyPrefix: 'feedback'
});

// Legacy alias for backwards compatibility
const pollingRateLimiter = agentPollingRateLimiter;

module.exports = {
  createRateLimiter,
  generalRateLimiter,
  authRateLimiter,
  userPollingRateLimiter,
  agentPollingRateLimiter,
  pollingRateLimiter,
  agentApiRateLimiter,
  agentMessageIngressRateLimiter,
  feedbackRateLimiter,
  getUsageStatus,
  resolveClientIdentifier,
  resolveAgentName
};
