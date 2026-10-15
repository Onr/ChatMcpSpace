'use strict';

const crypto = require('crypto');
const { logRateLimitViolation } = require('../utils/securityLogger');

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_CLIENT_MAX = 5;
const DEFAULT_LINK_MAX = 20;

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function clientIdentifier(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function unavailableError() {
  const error = new Error('Guest rate limit backing store unavailable');
  error.code = 'GUEST_RATE_LIMIT_STORE_UNAVAILABLE';
  return error;
}

function readyStore(store) {
  return store && (store.isReady === undefined || store.isReady === true)
    && typeof store.incr === 'function'
    && typeof store.pExpire === 'function'
    && typeof store.pTTL === 'function';
}

async function increment(store, key, windowMs) {
  if (!readyStore(store)) throw unavailableError();
  let count;
  try {
    count = Number(await store.incr(key));
    if (!Number.isFinite(count)) throw new Error('Invalid rate limit counter');
    if (count === 1) await store.pExpire(key, windowMs);
    const ttl = Number(await store.pTTL(key));
    return {
      count,
      ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : windowMs
    };
  } catch (error) {
    const unavailable = unavailableError();
    unavailable.cause = error;
    throw unavailable;
  }
}

function createGuestUnlockRateLimiter({
  store,
  windowMs = positiveInt(process.env.GUEST_UNLOCK_WINDOW_MS, DEFAULT_WINDOW_MS),
  clientMax = positiveInt(process.env.GUEST_UNLOCK_CLIENT_MAX, DEFAULT_CLIENT_MAX),
  linkMax = positiveInt(process.env.GUEST_UNLOCK_LINK_MAX, DEFAULT_LINK_MAX),
  keyPrefix = 'guest-unlock'
} = {}) {
  const middleware = async (req, res, next) => {
    const selectedStore = store === undefined
      ? require('../utils/redisClient').rateLimitRedisClient
      : store;
    const linkSecret = req.body?.linkSecret;
    const keys = [
      `${keyPrefix}:client:${digest(clientIdentifier(req))}`,
      `${keyPrefix}:link:${digest(linkSecret)}`
    ];
    try {
      const [client, link] = await Promise.all([
        increment(selectedStore, keys[0], windowMs),
        increment(selectedStore, keys[1], windowMs)
      ]);
      const retryAfter = Math.max(client.ttl, link.ttl);
      res.set({
        'X-RateLimit-Limit': String(Math.min(clientMax, linkMax)),
        'X-RateLimit-Remaining': String(Math.max(0, Math.min(clientMax - client.count, linkMax - link.count))),
        'X-RateLimit-Reset': new Date(Date.now() + retryAfter).toISOString(),
        'X-RateLimit-Scope': keyPrefix
      });
      if (client.count > clientMax || link.count > linkMax) {
        logRateLimitViolation(req, keyPrefix);
        const retryAfterSeconds = Math.max(1, Math.ceil(retryAfter / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
          error: {
            code: 'GUEST_UNLOCK_RATE_LIMITED',
            message: 'Too many guest unlock attempts, please try again later',
            retryAfter: retryAfterSeconds
          }
        });
      }
      next();
    } catch (error) {
      if (error.code === 'GUEST_RATE_LIMIT_STORE_UNAVAILABLE') {
        return res.status(503).json({
          error: {
            code: 'GUEST_RATE_LIMIT_UNAVAILABLE',
            message: 'Guest access is temporarily unavailable'
          }
        });
      }
      next(error);
    }
  };
  middleware.config = { windowMs, clientMax, linkMax, keyPrefix };
  return middleware;
}

const guestUnlockRateLimiter = createGuestUnlockRateLimiter();

module.exports = {
  createGuestUnlockRateLimiter,
  guestUnlockRateLimiter,
  digest
};
