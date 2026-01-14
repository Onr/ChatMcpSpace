/**
 * Rate Limiting Middleware
 * Implements rate limiting for different types of routes
 */

const { logRateLimitViolation } = require('../utils/securityLogger');
const { rateLimitRedisClient } = require('../utils/redisClient');

// In-memory fallback store (used only if Redis is unavailable)
const fallbackStore = new Map();
const FALLBACK_TTL_MS = 60_000;

function cleanupFallbackStore() {
  const now = Date.now();
  for (const [key, data] of fallbackStore.entries()) {
    if (now - data.resetTime > FALLBACK_TTL_MS) {
      fallbackStore.delete(key);
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

/**
 * Create a rate limiter middleware with specified options
 * @param {Object} options - Rate limiter configuration
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum number of requests per window
 * @param {string} options.message - Error message to return when limit exceeded
 * @param {string} options.keyPrefix - Prefix for the rate limit key
 * @param {boolean} options.perAgent - If true, include agent name in the key (for per-agent limits)
 * @returns {Function} Express middleware function
 */
function createRateLimiter(options) {
  const {
    windowMs = 60000, // Default: 1 minute
    max = 60, // Default: 60 requests per window
    message = 'Too many requests, please try again later',
    keyPrefix = 'rl',
    perAgent = false
  } = options;

  return async function rateLimitMiddleware(req, res, next) {
    try {
      const clientIdentifier = req.user?.userId || req.headers['x-api-key'] || req.ip || 'unknown';
      
      // For per-agent rate limiting, include agent name in the key
      let key = `${keyPrefix}:${clientIdentifier}`;
      if (perAgent) {
        const agentName = req.query?.agentName || req.body?.agentName || 'unknown';
        key = `${keyPrefix}:${clientIdentifier}:${agentName}`;
      }

      const redisResult = await incrementWithRedis(key, windowMs);
      const result = redisResult || incrementFallback(key, windowMs);

      const ttlMs = typeof result.ttl === 'number' && result.ttl > 0 ? result.ttl : windowMs;
      const resetTime = Date.now() + ttlMs;

      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - result.count));
      res.setHeader('X-RateLimit-Reset', new Date(resetTime).toISOString());

      if (result.count > max) {
        logRateLimitViolation(req, keyPrefix);

        const retryAfterSeconds = Math.ceil(ttlMs / 1000);
        res.setHeader('Retry-After', retryAfterSeconds);

        return res.status(429).json({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: message,
            retryAfter: retryAfterSeconds
          }
        });
      }

      next();
    } catch (error) {
      console.error('[RateLimit] Middleware failure:', error.message);
      next();
    }
  };
}

/**
 * General rate limiter for all routes
 * 100 requests per minute per IP
 */
const generalRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 100,
  message: 'Too many requests from this IP, please try again later',
  keyPrefix: 'general'
});

/**
 * Strict rate limiter for authentication endpoints
 * 5 requests per minute per IP to prevent brute force attacks
 */
const authRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 5,
  message: 'Too many authentication attempts, please try again later',
  keyPrefix: 'auth'
});

/**
 * Rate limiter for user dashboard polling endpoints
 * 300 requests per minute per session (generous for UI)
 */
const userPollingRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 300,
  message: 'Too many requests, please slow down',
  keyPrefix: 'user-polling'
});

/**
 * Rate limiter for agent API polling endpoints (per agent)
 * 30 requests per minute per agent (poll every 2 seconds max)
 * Each agent gets its own quota
 */
const agentPollingRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 30,
  message: 'Too many polling requests for this agent, please slow down',
  keyPrefix: 'agent-polling',
  perAgent: true
});

/**
 * Rate limiter for overall agent API usage per user
 * 300 requests per minute total across all agents (5x the per-agent limit)
 */
const agentApiRateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 300,
  message: 'Too many API requests, please try again later',
  keyPrefix: 'agent-api'
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
  agentApiRateLimiter
};
