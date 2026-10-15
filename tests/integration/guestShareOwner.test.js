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
let fixture, guest, app, owner, outsider, agentOne, agentTwo, outsiderAgent;

async function setup() {
  jest.resetModules();
  if (process.env.SHARED_TEST_DATABASE_URL) {
    const { Pool } = require('pg');
    const schemaName = 'share_owner_test_' + uid().replace(/-/g, '');
    const admin = new Pool({ connectionString: process.env.SHARED_TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    const pool = new Pool({ connectionString: process.env.SHARED_TEST_DATABASE_URL, options: `-c search_path=${schemaName}` });
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
  if (process.env.SHARED_TEST_DATABASE_URL) for (const file of ['048_enforce_guest_room_relationships.sql', '049_retain_guest_history_attribution.sql']) {
    await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
  }
  jest.doMock('../../src/db/connection', () => ({
    query: fixture.query,
    getClient: () => fixture.pool.connect()
  }));
  guest = require('../../src/shared/guestService');
  owner = await seedUser(fixture.query, { email: 'share-owner@example.test' });
  outsider = await seedUser(fixture.query, { email: 'share-outsider@example.test' });
  agentOne = uid();
  agentTwo = uid();
  outsiderAgent = uid();
  await fixture.query(`INSERT INTO agents(agent_id,user_id,agent_name,position,allowed_permissions)
    VALUES($1,$2,'Selected one',0,'{}'::jsonb),($3,$2,'Selected two',1,'{}'::jsonb),($4,$5,'Other owner agent',0,'{}'::jsonb)`, [agentOne, owner.userId, agentTwo, outsiderAgent, outsider.userId]);
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_GUEST_SHARING = 'true';
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: req.headers['x-test-user'] || owner.userId };
    next();
  });
  app.use('/shared', require('../../src/shared/routes').users);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { message: error.message } }));
}

beforeEach(setup);
afterEach(async () => {
  await fixture?.cleanup();
  delete process.env.FEATURE_SHARED_CONVERSATIONS;
  delete process.env.FEATURE_GUEST_SHARING;
  jest.resetModules();
});

test('owner can atomically share selected agents and raw link secrets are never stored or listed', async () => {
  process.env.FEATURE_GUEST_SHARING = 'false';
  const rejected = await request(app).post('/shared/guest-shares').send({ agentIds: [agentTwo] });
  expect(rejected.status).toBe(404);
  process.env.FEATURE_GUEST_SHARING = 'true';
  const response = await request(app).post('/shared/guest-shares').send({
    agentIds: [agentOne, agentTwo],
    roomMode: 'separate'
  });
  expect(response.status).toBe(200);
  expect(response.body.linkSecret).toEqual(expect.any(String));
  expect(response.body.agents).toHaveLength(2);
  const row = (await fixture.query('SELECT token_hash,password_hash FROM guest_shares WHERE share_id=$1', [response.body.shareId])).rows[0];
  expect(row.password_hash).toBeNull();
  expect(row.token_hash).not.toBe(response.body.linkSecret);
  expect(row.token_hash).toBe(crypto.createHash('sha256').update(response.body.linkSecret).digest('base64url'));
  const list = await request(app).get('/shared/guest-shares');
  expect(list.status).toBe(200);
  expect(JSON.stringify(list.body)).not.toContain(response.body.linkSecret);
  expect(JSON.stringify(list.body)).not.toContain(row.token_hash);
  const mappings = (await fixture.query('SELECT agent_id,room_id,removed_at FROM guest_share_agents WHERE share_id=$1 ORDER BY agent_id', [response.body.shareId])).rows;
  expect(mappings).toHaveLength(2);
  expect(mappings.every(mapping => mapping.room_id === null && mapping.removed_at === null)).toBe(true);
});

test('mixed-owner selected-agent input creates nothing', async () => {
  const before = Number((await fixture.query('SELECT COUNT(*) AS count FROM guest_shares')).rows[0].count);
  const response = await request(app).post('/shared/guest-shares').send({
    agentIds: [agentOne, outsiderAgent]
  });
  expect(response.status).toBe(403);
  const after = Number((await fixture.query('SELECT COUNT(*) AS count FROM guest_shares')).rows[0].count);
  expect(after).toBe(before);
});

test('common-room selection creates an explicit owner-visible room and link replacement revokes sessions', async () => {
  const response = await request(app).post('/shared/guest-shares').send({
    agentIds: [agentOne],
    roomMode: 'common'
  });
  const shareId = response.body.shareId;
  const mapping = (await fixture.query('SELECT room_id FROM guest_share_agents WHERE share_id=$1', [shareId])).rows[0];
  expect(mapping.room_id).toEqual(expect.any(String));
  const principal = await guest.createGuestPrincipal({ shareId, displayName: 'Guest' });
  const session = await guest.createGuestSession({
    shareId,
    guestId: principal.guest_id,
    sessionTokenHash: 's'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000)
  });
  const replacement = await request(app).patch(`/shared/guest-shares/${shareId}`).send({ replaceLink: true });
  expect(replacement.status).toBe(200);
  expect(replacement.body.linkSecret).toEqual(expect.any(String));
  expect((await fixture.query('SELECT revoked_at FROM guest_sessions WHERE session_id=$1', [session.session_id])).rows[0].revoked_at).not.toBeNull();
  const revoked = await request(app).delete(`/shared/guest-shares/${shareId}`);
  expect(revoked.status).toBe(200);
  expect((await fixture.query('SELECT revoked_at FROM guest_shares WHERE share_id=$1', [shareId])).rows[0].revoked_at).not.toBeNull();
});

test('guest link can attach to the owner-selected shared conversation instead of creating a separate room', async () => {
  const room = await request(app).post('/shared/guest-shares').send({ agentIds:[agentOne],roomMode:'common' });
  const conversationId=(await fixture.query('SELECT room_id FROM guest_share_agents WHERE share_id=$1',[room.body.shareId])).rows[0].room_id;
  const before=Number((await fixture.query('SELECT COUNT(*) AS count FROM shared_conversations')).rows[0].count);
  const link=await request(app).post('/shared/guest-shares').send({
    agentIds:[agentOne],roomMode:'common',conversationId,title:'Existing conversation'
  });
  expect(link.status).toBe(200);
  expect(link.body.conversationId).toBe(conversationId);
  expect((await fixture.query('SELECT room_id FROM guest_share_agents WHERE share_id=$1',[link.body.shareId])).rows[0].room_id).toBe(conversationId);
  expect(Number((await fixture.query('SELECT COUNT(*) AS count FROM shared_conversations')).rows[0].count)).toBe(before);
  const outsiderRoom=await request(app).post('/shared/guest-shares').set('x-test-user',outsider.userId).send({
    agentIds:[agentOne],roomMode:'common',conversationId
  });
  expect(outsiderRoom.status).toBe(404);
});

test('guest account unlock resolves the linked existing conversation and reads its canonical history', async () => {
  const original=await request(app).post('/shared/guest-shares').send({agentIds:[agentOne],roomMode:'common'});
  const conversationId=(await fixture.query('SELECT room_id FROM guest_share_agents WHERE share_id=$1',[original.body.shareId])).rows[0].room_id;
  const linked=await request(app).post('/shared/guest-shares').send({agentIds:[agentOne],roomMode:'common',conversationId});
  expect(linked.body.conversationId).toBe(conversationId);
  const verifiedShare=await guest.findShareByLinkSecret(linked.body.linkSecret);
  const sessionTokenHash=crypto.randomBytes(32).toString('base64url');
  const {session}=await guest.createUnlockedGuestSession({verifiedShare,displayName:'Guest reviewer',sessionTokenHash,csrfSecretHash:crypto.randomBytes(32).toString('base64url')});
  const workspace=await guest.guestWorkspace({sessionId:session.session_id,sessionTokenHash});
  expect(workspace.rooms).toEqual([expect.objectContaining({roomId:conversationId,status:'pending'})]);
  const id=uid();
  await fixture.query(`INSERT INTO shared_messages(id,conversation_id,sender_user_id,kind,payload,key_version)
    VALUES($1,$2,$3,'message',$4::jsonb,1)`,[id,conversationId,owner.userId,JSON.stringify({v:1,iv:'iv',data:'ciphertext'})]);
  await guest.addGuestMember({shareId:linked.body.shareId,guestId:workspace.guest.guest_id,roomId:conversationId,status:'active'});
  const timeline=await guest.guestHistory({sessionId:session.session_id,sessionTokenHash,roomId:conversationId});
  expect(timeline.map(row=>row.id)).toContain(id);
  expect((await fixture.query('SELECT conversation_id FROM shared_messages WHERE id=$1',[id])).rows[0].conversation_id).toBe(workspace.rooms[0].roomId);
});
