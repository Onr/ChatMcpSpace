const { createClient } = require('redis');

/**
 * Create and connect a Redis client with shared configuration.
 * Supports either REDIS_URL or host/port/password/database variables.
 *
 * @param {number|null|undefined} dbOverride Optional DB index to override the default.
 * @param {Object} options Optional client options
 * @param {boolean} options.legacyMode Whether to enable legacy mode (needed for some stores)
 * @returns {import('redis').RedisClientType|null}
 */
function createRedisClient(dbOverride, options = {}) {
  try {
    const url = process.env.REDIS_URL;
    const hasUrl = Boolean(url);
    const socketHost = process.env.REDIS_HOST || '127.0.0.1';
    const socketPort = process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379;
    const password = process.env.REDIS_PASSWORD || undefined;
    const database = typeof dbOverride === 'number'
      ? dbOverride
      : (process.env.REDIS_DB ? Number(process.env.REDIS_DB) : 0);

    const client = hasUrl
      ? createClient({ url, legacyMode: Boolean(options.legacyMode) })
      : createClient({
          socket: { host: socketHost, port: socketPort },
          password,
          database,
          legacyMode: Boolean(options.legacyMode),
        });

    client.on('error', (err) => {
      console.error('[Redis] Client error:', err.message);
    });

    // Connect in the background; we intentionally do not await to avoid blocking boot.
    client.connect().catch((err) => {
      console.error('[Redis] Failed to connect:', err.message);
    });

    return client;
  } catch (error) {
    console.error('[Redis] Failed to initialize client:', error.message);
    return null;
  }
}

// Dedicated clients for session storage and rate limiting (can share DB or use overrides).
// Note: connect-redis v7+ works with redis v4 client directly, no legacyMode needed
const sessionRedisClient = createRedisClient(
  process.env.REDIS_SESSION_DB ? Number(process.env.REDIS_SESSION_DB) : undefined,
  { legacyMode: false }
);

const rateLimitRedisClient = createRedisClient(
  process.env.REDIS_RATE_DB
    ? Number(process.env.REDIS_RATE_DB)
    : (process.env.REDIS_DB ? Number(process.env.REDIS_DB) : undefined)
);

module.exports = {
  createRedisClient,
  sessionRedisClient,
  rateLimitRedisClient,
};
