const express = require('express');
const request = require('supertest');

describe('Rate limit middleware', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  function buildApp({ perAgent = false } = {}) {
    jest.doMock('../../src/utils/redisClient', () => ({ rateLimitRedisClient: null }));
    jest.doMock('../../src/utils/securityLogger', () => ({ logRateLimitViolation: jest.fn() }));

    const { createRateLimiter } = require('../../src/middleware/rateLimitMiddleware');
    const limiter = createRateLimiter({
      windowMs: 1000,
      max: 2,
      message: 'too many',
      keyPrefix: perAgent ? 'per-agent' : 'global',
      perAgent,
    });

    const app = express();
    app.use(express.json());
    app.get('/ping', limiter, (_req, res) => res.status(200).json({ ok: true }));
    return { app, limiter };
  }

  it('allows requests under the limit and sets rate limit headers', async () => {
    const { app } = buildApp();

    const first = await request(app).get('/ping').expect(200);
    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
    expect(first.headers['x-ratelimit-reset']).toBeTruthy();

    const second = await request(app).get('/ping').expect(200);
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('returns 429 when the limit is exceeded', async () => {
    const { app } = buildApp();
    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(200);

    const third = await request(app).get('/ping').expect(429);
    expect(third.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(third.body.error.message).toBe('too many');
    expect(typeof third.body.error.retryAfter).toBe('number');
    expect(third.headers['x-ratelimit-remaining']).toBe('0');
    expect(third.headers['x-ratelimit-reset']).toBeTruthy();
    expect(third.headers['retry-after']).toBeTruthy();
  });

  it('resets the quota after the window elapses', async () => {
    const dateNowSpy = jest.spyOn(Date, 'now');
    let nowMs = 1_000_000;
    dateNowSpy.mockImplementation(() => nowMs);

    const { app } = buildApp();
    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(429);

    nowMs += 1001;
    const afterReset = await request(app).get('/ping').expect(200);
    expect(afterReset.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('clamps negative redis TTL values when setting reset headers', async () => {
    const dateNowSpy = jest.spyOn(Date, 'now');
    const nowMs = 5_000_000;
    dateNowSpy.mockImplementation(() => nowMs);

    const incr = jest.fn().mockResolvedValue(1);
    const pExpire = jest.fn().mockResolvedValue(1);
    const pTTL = jest.fn().mockResolvedValue(-1);

    jest.doMock('../../src/utils/securityLogger', () => ({ logRateLimitViolation: jest.fn() }));
    jest.doMock('../../src/utils/redisClient', () => ({
      rateLimitRedisClient: {
        isReady: true,
        incr,
        pExpire,
        pTTL,
      },
    }));

    const { createRateLimiter } = require('../../src/middleware/rateLimitMiddleware');
    const limiter = createRateLimiter({
      windowMs: 5000,
      max: 2,
      message: 'too many',
      keyPrefix: 'redis',
    });

    const app = express();
    app.get('/ping', limiter, (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/ping').expect(200);
    expect(Date.parse(res.headers['x-ratelimit-reset'])).toBe(nowMs + 5000);
  });

  it('isolates quotas per agent when enabled', async () => {
    jest.doMock('../../src/utils/redisClient', () => ({ rateLimitRedisClient: null }));
    jest.doMock('../../src/utils/securityLogger', () => ({ logRateLimitViolation: jest.fn() }));

    const { createRateLimiter } = require('../../src/middleware/rateLimitMiddleware');
    const limiter = createRateLimiter({
      windowMs: 1000,
      max: 2,
      message: 'too many',
      keyPrefix: 'agent',
      perAgent: true,
    });

    const app = express();
    app.use(express.json());
    app.get('/ping', limiter, (_req, res) => res.status(200).json({ ok: true }));

    await request(app).get('/ping').query({ agentName: 'A' }).expect(200);
    await request(app).get('/ping').query({ agentName: 'A' }).expect(200);
    await request(app).get('/ping').query({ agentName: 'B' }).expect(200);
    await request(app).get('/ping').query({ agentName: 'B' }).expect(200);

    await request(app).get('/ping').query({ agentName: 'A' }).expect(429);
    await request(app).get('/ping').query({ agentName: 'B' }).expect(429);
  });
});
