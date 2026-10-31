'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const { seedUser } = require('../utils/pgMemTestUtils');
const { migrationForFixture } = require('../utils/sharedMigrationFixture');

const schema = fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8');
const migrations = [
  '042_add_shared_conversations.sql',
  '043_add_agent_devices_and_share_grants.sql',
  '044_add_shared_task_context.sql',
  '045_add_guest_principals_and_membership.sql',
  '047_add_guest_separate_rooms.sql',
  '050_bind_guest_request_revisions.sql',
  '051_retain_shared_task_attempts.sql'
].map(file => fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
const uid = () => crypto.randomUUID();

class SharedStore {
  constructor() {
    this.isReady = true;
    this.values = new Map();
    this.expiry = new Map();
  }

  async incr(key) {
    const current = this.values.get(key) || 0;
    const next = current + 1;
    this.values.set(key, next);
    return next;
  }

  async pExpire(key, ttl) {
    this.expiry.set(key, Date.now() + ttl);
    return 1;
  }

  async pTTL(key) {
    return Math.max(1, (this.expiry.get(key) || Date.now() + 60_000) - Date.now());
  }
}

let fixture;
let guest;
let owner;
let agentId;
let share;
let createGuestRouter;
let createGuestUnlockRateLimiter;

async function setup() {
  jest.resetModules();
  if (process.env.SHARED_TEST_DATABASE_URL) {
    const { Pool } = require('pg');
    const schemaName = `guest_auth_${uid().replace(/-/g, '')}`;
    const admin = new Pool({ connectionString: process.env.SHARED_TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    const pool = new Pool({
      connectionString: process.env.SHARED_TEST_DATABASE_URL,
      options: `-c search_path=${schemaName}`
    });
    await pool.query(schema);
    fixture = {
      pool,
      query: (text, params) => pool.query(text, params),
      cleanup: async () => {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
        await admin.end();
      }
    };
  } else {
    const memory = newDb({ autoCreateForeignKeyIndices: false });
    memory.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid', implementation: uid, impure: true });
    memory.public.registerFunction({ name: 'now', returns: 'timestamp', implementation: () => new Date(), impure: true });
    memory.public.none(schema);
    const pg = memory.adapters.createPg();
    const pool = new pg.Pool();
    fixture = {
      pool,
      query: (text, params) => pool.query(text, params),
      cleanup: () => pool.end()
    };
  }
  for (const migration of migrations) await fixture.query(migrationForFixture(migration, Boolean(process.env.SHARED_TEST_DATABASE_URL)));
  await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/064_add_sharing_switch.sql'), 'utf8'));
  await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/065_guest_approval_and_limits.sql'), 'utf8'));
  await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/066_guest_link_requests.sql'), 'utf8'));
  if (process.env.SHARED_TEST_DATABASE_URL) for (const file of ['048_enforce_guest_room_relationships.sql', '049_retain_guest_history_attribution.sql']) {
    await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
  }
  jest.doMock('../../src/db/connection', () => ({
    query: fixture.query,
    getClient: () => fixture.pool.connect()
  }));
  guest = require('../../src/shared/guestService');
  ({ createGuestRouter } = require('../../src/shared/guestRoutes'));
  ({ createGuestUnlockRateLimiter } = require('../../src/middleware/guestRateLimit'));
  owner = await seedUser(fixture.query, { email: 'guest-auth-owner@example.test' });
  agentId = uid();
  await fixture.query(`INSERT INTO agents(agent_id,user_id,agent_name,position,allowed_permissions)
    VALUES($1,$2,'Auth test agent',0,'{}'::jsonb)`, [agentId, owner.userId]);
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_GUEST_SHARING = 'true';
  share = await guest.createOwnerShare(owner.userId, {
    agentIds: [agentId],
    password: 'correct horse battery staple'
  });
}

function appWithStore(store = new SharedStore(), limits = {}) {
  const app = express();
  app.use(express.json());
  // Simulate an account session to prove guest routes do not replace it.
  app.use((req, _res, next) => {
    req.session = { userId: owner.userId };
    req.user = { userId: owner.userId };
    next();
  });
  app.get('/account-state', (req, res) => res.json({ userId: req.session.userId }));
  const rateLimiter = createGuestUnlockRateLimiter({
    store,
    clientMax: limits.clientMax || 5,
    linkMax: limits.linkMax || 20,
    windowMs: 60_000,
    keyPrefix: limits.keyPrefix || 'guest-unlock-test'
  });
  app.use('/api/guest', createGuestRouter({ rateLimiter }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { message: error.message } }));
  return app;
}

function cookieJar(response) {
  return response.headers['set-cookie'];
}

beforeEach(setup);
afterEach(async () => {
  await fixture?.cleanup();
  delete process.env.FEATURE_SHARED_CONVERSATIONS;
  delete process.env.FEATURE_GUEST_SHARING;
  jest.resetModules();
});

test('link-only/password unlock creates a separate session without account impersonation', async () => {
  const app = appWithStore();
  const wrong = await request(app).post('/api/guest/unlock').send({
    linkSecret: share.linkSecret,
    password: 'wrong password',
    displayName: 'Wrong guest'
  });
  expect(wrong.status).toBe(401);
  expect(wrong.body.error.code).toBe('GUEST_UNLOCK_FAILED');
  expect(JSON.stringify(wrong.body)).not.toContain('Auth test agent');

  const unlocked = await request(app).post('/api/guest/unlock').send({
    linkSecret: share.linkSecret,
    password: 'correct horse battery staple',
    displayName: 'Guest reviewer'
  });
  expect(unlocked.status).toBe(200);
  expect(unlocked.body.guest.displayName).toBe('Guest reviewer');
  expect(unlocked.body.share).toEqual(expect.objectContaining({ shareId: share.shareId, roomMode: 'separate' }));
  expect(unlocked.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(cookieJar(unlocked).some(cookie => cookie.startsWith('guest_sid=') && /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie))).toBe(true);
  expect(cookieJar(unlocked).some(cookie => cookie.startsWith('guest_csrf=') && !/HttpOnly/i.test(cookie))).toBe(true);

  const session = await request(app).get('/api/guest/session').set('Cookie', cookieJar(unlocked));
  expect(session.status).toBe(200);
  expect(session.body.guest.guestId).toBe(unlocked.body.guest.guestId);
  expect((await request(app).get('/account-state')).body.userId).toBe(owner.userId);
  const rows = (await fixture.query('SELECT gs.password_hash,ss.session_token_hash,ss.csrf_secret_hash FROM guest_shares gs JOIN guest_sessions ss USING(share_id) WHERE gs.share_id=$1', [share.shareId])).rows;
  expect(rows[0].password_hash).not.toBeNull();
  expect(rows[0].session_token_hash).not.toContain(unlocked.body.csrfToken);
  expect(rows[0].csrf_secret_hash).not.toBe(unlocked.body.csrfToken);
});

test('a password replaced after verification cannot create a current-revision session', async () => {
  const bcrypt = require('bcrypt');
  const compare = bcrypt.compare.bind(bcrypt);
  const verification = jest.spyOn(bcrypt, 'compare').mockImplementationOnce(async (password, digest) => {
    const valid = await compare(password, digest);
    await guest.updateOwnerShare(owner.userId, share.shareId, { password: 'a changed sufficiently long password' });
    return valid;
  });
  try {
    const unlocked = await request(appWithStore()).post('/api/guest/unlock').send({
      linkSecret: share.linkSecret, password: 'correct horse battery staple', displayName: 'Stale password'
    });
    expect(unlocked.status).toBe(401);
    expect(unlocked.body.error.code).toBe('GUEST_UNLOCK_FAILED');
    expect(unlocked.headers['set-cookie']).toBeUndefined();
    expect((await fixture.query('SELECT guest_id FROM guest_principals WHERE share_id=$1', [share.shareId])).rows).toHaveLength(0);
    expect((await fixture.query('SELECT session_id FROM guest_sessions WHERE share_id=$1', [share.shareId])).rows).toHaveLength(0);
  } finally { verification.mockRestore(); }
});

test('guest mutations require the guest CSRF token and same-origin request', async () => {
  const app = appWithStore();
  const unlocked = await request(app).post('/api/guest/unlock').send({
    linkSecret: share.linkSecret,
    password: 'correct horse battery staple',
    displayName: 'Guest reviewer'
  });
  const cookies = cookieJar(unlocked);
  const missing = await request(app).post('/api/guest/logout').set('Cookie', cookies);
  expect(missing.status).toBe(403);
  expect(missing.body.error.code).toBe('GUEST_CSRF_INVALID');
  const crossOrigin = await request(app).post('/api/guest/logout')
    .set('Cookie', cookies)
    .set('Origin', 'https://evil.example')
    .set('x-guest-csrf', unlocked.body.csrfToken);
  expect(crossOrigin.status).toBe(403);
  expect(crossOrigin.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  const logout = await request(app).post('/api/guest/logout')
    .set('Cookie', cookies)
    .set('x-guest-csrf', unlocked.body.csrfToken);
  expect(logout.status).toBe(200);
  const after = await request(app).get('/api/guest/session').set('Cookie', cookies);
  expect(after.status).toBe(401);
  expect((await request(app).get('/account-state')).body.userId).toBe(owner.userId);
});

test('password replacement, share revocation and expiry invalidate old guest sessions', async () => {
  const app = appWithStore();
  const unlocked = await request(app).post('/api/guest/unlock').send({
    linkSecret: share.linkSecret,
    password: 'correct horse battery staple',
    displayName: 'Guest reviewer'
  });
  await guest.updateOwnerShare(owner.userId, share.shareId, { password: 'new correct password' });
  expect((await request(app).get('/api/guest/session').set('Cookie', cookieJar(unlocked))).status).toBe(401);

  const replacement = await guest.updateOwnerShare(owner.userId, share.shareId, { replaceLink: true });
  const newUnlock = await request(app).post('/api/guest/unlock').send({
    linkSecret: replacement.linkSecret,
    password: 'new correct password',
    displayName: 'Fresh guest'
  });
  expect(newUnlock.status).toBe(200);
  await guest.updateOwnerShare(owner.userId, share.shareId, { revoked: true });
  expect((await request(app).get('/api/guest/session').set('Cookie', cookieJar(newUnlock))).status).toBe(401);
});

test('unlock rate limits are shared across application instances and fail closed without the store', async () => {
  const sharedStore = new SharedStore();
  const appA = appWithStore(sharedStore, { clientMax: 2 });
  const appB = appWithStore(sharedStore, { clientMax: 2 });
  const payload = {
    linkSecret: share.linkSecret,
    password: 'wrong password',
    displayName: 'Guest reviewer'
  };
  expect((await request(appA).post('/api/guest/unlock').send(payload)).status).toBe(401);
  expect((await request(appB).post('/api/guest/unlock').send(payload)).status).toBe(401);
  const limited = await request(appA).post('/api/guest/unlock').send(payload);
  expect(limited.status).toBe(429);
  expect(limited.body.error.code).toBe('GUEST_UNLOCK_RATE_LIMITED');

  const unavailable = appWithStore({ isReady: false });
  const blocked = await request(unavailable).post('/api/guest/unlock').send(payload);
  expect(blocked.status).toBe(503);
  expect(blocked.body.error.code).toBe('GUEST_RATE_LIMIT_UNAVAILABLE');
});

(process.env.GUEST_TEST_REDIS_URL ? test : test.skip)('real Redis shares unlock limits across two application instances', async () => {
  const { createClient } = require('redis');
  const clientA = createClient({ url: process.env.GUEST_TEST_REDIS_URL });
  const clientB = createClient({ url: process.env.GUEST_TEST_REDIS_URL });
  await Promise.all([clientA.connect(), clientB.connect()]);
  const keyPrefix = `guest-s10-real-${uid()}`;
  try {
    const appA = appWithStore(clientA, { clientMax: 2, keyPrefix });
    const appB = appWithStore(clientB, { clientMax: 2, keyPrefix });
    const payload = {
      linkSecret: share.linkSecret,
      password: 'wrong password',
      displayName: 'Guest reviewer'
    };
    expect((await request(appA).post('/api/guest/unlock').send(payload)).status).toBe(401);
    expect((await request(appB).post('/api/guest/unlock').send(payload)).status).toBe(401);
    expect((await request(appA).post('/api/guest/unlock').send(payload)).status).toBe(429);
  } finally {
    await Promise.all([clientA.quit(), clientB.quit()]);
  }
});

test('guest feature flag denies new unlocks and existing sessions', async () => {
  const app = appWithStore();
  const unlocked = await request(app).post('/api/guest/unlock').send({
    linkSecret: share.linkSecret,
    password: 'correct horse battery staple',
    displayName: 'Existing guest'
  });
  expect(unlocked.status).toBe(200);
  process.env.FEATURE_GUEST_SHARING = 'false';
  const response = await request(app).post('/api/guest/unlock').send({ linkSecret: share.linkSecret });
  expect(response.status).toBe(404);
  expect(response.body.error.code).toBe('GUEST_SHARING_DISABLED');
  const existing = await request(app).get('/api/guest/session').set('Cookie', cookieJar(unlocked));
  expect(existing.status).toBe(404);
  expect(existing.body.error.code).toBe('GUEST_SHARING_DISABLED');
});
