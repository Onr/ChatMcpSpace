const express = require('express');
const request = require('supertest');
const { createClient } = require('redis');
const { randomUUID } = require('crypto');

// Opt in to a real Redis instance; every key belongs to this test run.
const redisTests = process.env.RATE_LIMIT_TEST_REDIS_URL ? describe : describe.skip;

redisTests('Redis rate-limit expiry', () => {
  let client;
  let createRateLimiter;
  const keys = [];

  beforeAll(async () => {
    client = createClient({ url: process.env.RATE_LIMIT_TEST_REDIS_URL });
    await client.connect();
    jest.doMock('../../src/utils/redisClient', () => ({ rateLimitRedisClient: client }));
    jest.doMock('../../src/utils/securityLogger', () => ({ logRateLimitViolation: jest.fn() }));
    ({ createRateLimiter } = require('../../src/middleware/rateLimitMiddleware'));
  });

  afterAll(async () => {
    if (client?.isReady) {
      if (keys.length) await client.del(keys);
      await client.quit();
    }
    jest.resetModules();
  });

  function appFor({ max = 2, windowMs = 60000 } = {}) {
    const prefix = `test-rate-expiry:${randomUUID()}`;
    const key = `${prefix}:test-user`;
    keys.push(key);
    const app = express();
    app.use((req, _res, next) => { req.user = { userId: 'test-user' }; next(); });
    app.get('/ping', createRateLimiter({ max, windowMs, keyPrefix: prefix }),
      (_req, res) => res.json({ ok: true }));
    return { app, key };
  }

  it('repairs a saturated counter without expiry and admits traffic after its window', async () => {
    const { app, key } = appFor({ windowMs: 300 });
    await client.set(key, '168000');
    expect(await client.pTTL(key)).toBe(-1);

    await request(app).get('/ping').expect(429);
    const ttl = await client.pTTL(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);

    await new Promise(resolve => setTimeout(resolve, 350));
    const response = await request(app).get('/ping').expect(200);
    expect(response.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('preserves an existing expiry instead of extending the window on each request', async () => {
    const { app, key } = appFor();
    await client.set(key, '1', { PX: 15000 });
    const before = await client.pTTL(key);
    await request(app).get('/ping').expect(200);
    const after = await client.pTTL(key);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before);
    expect(await client.get(key)).toBe('2');
  });

  it('counts simultaneous requests exactly and always gives a new counter an expiry', async () => {
    const { app, key } = appFor({ max: 10 });
    const responses = await Promise.all(Array.from({ length: 20 }, () => request(app).get('/ping')));
    expect(responses.filter(response => response.status === 200)).toHaveLength(10);
    expect(responses.filter(response => response.status === 429)).toHaveLength(10);
    expect(await client.get(key)).toBe('20');
    expect(await client.pTTL(key)).toBeGreaterThan(0);
  });
});
