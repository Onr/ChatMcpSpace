'use strict';

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const { seedUser } = require('../utils/pgMemTestUtils');
const { migrationForFixture } = require('../utils/sharedMigrationFixture');

const C = require('../../public/js/shared-crypto');
const schema = fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8');
const migrations = [
  '042_add_shared_conversations.sql',
  '043_add_agent_devices_and_share_grants.sql',
  '044_add_shared_task_context.sql',
  '045_add_guest_principals_and_membership.sql',
  '047_add_guest_separate_rooms.sql',
  '050_bind_guest_request_revisions.sql',
  '051_retain_shared_task_attempts.sql',
  '052_bound_guest_file_storage.sql'
].map(file => fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
const uid = () => nodeCrypto.randomUUID();
const snapshots = rooms => rooms.map(room => ({ roomId: room.roomId, keyVersion: room.keyVersion,
  membershipVersion: room.membershipVersion, rotationRequired: room.rotationRequired }));

class TestStore {
  constructor() {
    this.isReady = true;
    this.counts = new Map();
  }

  async incr(key) {
    const count = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, count);
    return count;
  }

  async pExpire() {
    return 1;
  }

  async pTTL() {
    return 60_000;
  }
}

let fixture;
let guest;
let routes;
let owner;
let outsider;
let agents;
let identities;
let share;
let app;

async function identityPair() {
  const pair = await crypto.subtle.generateKey({
    name: 'RSA-OAEP',
    modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  }, false, ['wrapKey', 'unwrapKey']);
  return {
    pair,
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey)
  };
}

async function setup() {
  jest.resetModules();
  global.crypto = nodeCrypto.webcrypto;
  if (process.env.SHARED_TEST_DATABASE_URL) {
    const { Pool } = require('pg');
    const schemaName = `guest_provision_${uid().replace(/-/g, '')}`;
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
    memory.public.registerFunction({ name: 'octet_length', args: ['bytea'], returns: 'integer', implementation: bytes => bytes.length });
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
  routes = require('../../src/shared/routes');
  const guestRoutes = require('../../src/shared/guestRoutes');
  const { createGuestUnlockRateLimiter } = require('../../src/middleware/guestRateLimit');
  owner = await seedUser(fixture.query, { email: 'guest-provision-owner@example.test' });
  outsider = await seedUser(fixture.query, { email: 'guest-provision-outsider@example.test' });
  agents = [uid(), uid()];
  await fixture.query(`INSERT INTO agents(agent_id,user_id,agent_name,position,allowed_permissions)
    VALUES($1,$2,'Provisioned one',0,'{}'::jsonb),($3,$2,'Provisioned two',1,'{}'::jsonb)`, [agents[0], owner.userId, agents[1]]);
  identities = {
    owner: await identityPair(),
    first: await identityPair(),
    second: await identityPair(),
    guest: await identityPair()
  };
  await fixture.query(`INSERT INTO shared_identities(principal,public_key,private_key,display_name)
    VALUES($1,$2,NULL,'Owner'),($3,$4,NULL,'Provisioned one'),($5,$6,NULL,'Provisioned two')`, [
    `user:${owner.userId}`, JSON.stringify(identities.owner.publicKey),
    `agent:${agents[0]}`, JSON.stringify(identities.first.publicKey),
    `agent:${agents[1]}`, JSON.stringify(identities.second.publicKey)
  ]);
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_GUEST_SHARING = 'true';
  share = await guest.createOwnerShare(owner.userId, {
    agentIds: agents,
    roomMode: 'separate'
  });
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: req.headers['x-test-user'] || owner.userId };
    next();
  });
  app.use('/owner', routes.users);
  app.use('/guest', guestRoutes.createGuestRouter({
    rateLimiter: createGuestUnlockRateLimiter({ store: new TestStore(), keyPrefix: 'guest-provision-test' })
  }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { message: error.message } }));
}

beforeEach(setup);
afterEach(async () => {
  await fixture?.cleanup();
  delete process.env.FEATURE_SHARED_CONVERSATIONS;
  delete process.env.FEATURE_GUEST_SHARING;
  jest.resetModules();
});

test('guest identity stays public-only and owner provisioning activates only mapped rooms', async () => {
  const preview = await request(app).post('/guest/preview').send({ linkSecret: share.linkSecret });
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({
    ownerDisplayName: expect.any(String),
    agents: expect.arrayContaining([expect.objectContaining({ agentName: expect.any(String) })]),
    requiresCode: false
  });
  expect(preview.body.linkSecret).toBeUndefined();
  const unlocked = await request(app).post('/guest/unlock').send({
    linkSecret: share.linkSecret,
    displayName: 'Encrypted guest'
  });
  expect(unlocked.status).toBe(200);
  const cookies = unlocked.headers['set-cookie'];
  const workspace = await request(app).get('/guest/workspace').set('Cookie', cookies);
  expect(workspace.status).toBe(200);
  expect(workspace.body.rooms).toHaveLength(2);
  expect(workspace.body.rooms.every(room => room.status === 'pending' && room.keyReady === false)).toBe(true);
  const guestId = unlocked.body.guest.guestId;

  const identity = await request(app).put('/guest/identity')
    .set('Cookie', cookies)
    .set('x-guest-csrf', unlocked.body.csrfToken)
    .send({ publicKey: identities.guest.publicKey });
  expect(identity.status).toBe(200);
  expect(identity.body.rooms.every(room => room.status === 'pending')).toBe(true);
  const ownerView = await request(app).get(`/owner/guest-shares/${share.shareId}`);
  expect(ownerView.status).toBe(200);
  expect(ownerView.body.guests.find(item => item.guest_id === guestId).rooms.map(item => item.room_id).sort())
    .toEqual(identity.body.rooms.map(item => item.roomId).sort());
  const stored = (await fixture.query('SELECT public_key,status FROM guest_principals WHERE guest_id=$1', [guestId])).rows[0];
  expect(stored.public_key.n).toBe(identities.guest.publicKey.n);
  expect(stored.status).toBe('active');
  const sharedIdentity = (await fixture.query('SELECT public_key,private_key FROM shared_identities WHERE principal=$1', [`guest:${guestId}`])).rows[0];
  expect(sharedIdentity.public_key.n).toBe(identities.guest.publicKey.n);
  expect(sharedIdentity.private_key).toBeNull();

  const envelopes = [];
  for (const room of identity.body.rooms) {
    const key = await C.newKey();
    envelopes.push(
      { roomId: room.roomId, keyVersion: room.keyVersion, principal: `user:${owner.userId}`, wrappedKey: await C.wrap(key, identities.owner.publicKey) },
      { roomId: room.roomId, keyVersion: room.keyVersion, principal: `agent:${room.agentId}`, wrappedKey: await C.wrap(key, room.agentId === agents[0] ? identities.first.publicKey : identities.second.publicKey) },
      { roomId: room.roomId, keyVersion: room.keyVersion, principal: `guest:${guestId}`, wrappedKey: await C.wrap(key, identities.guest.publicKey) }
    );
  }
  const pending = await request(app).post(`/owner/guest-shares/${share.shareId}/keys`)
    .send({ guestId, envelopes, rooms: snapshots(identity.body.rooms) });
  expect(pending.status).toBe(200);
  expect(pending.body.rooms.every(room => room.status === 'active' && room.keyReady === true)).toBe(true);
  await fixture.query('UPDATE shared_conversations SET rotation_required=TRUE WHERE id=$1', [pending.body.rooms[0].roomId]);
  const rotatingRoom = (await request(app).get('/guest/workspace').set('Cookie', cookies)).body.rooms.find(room => room.roomId === pending.body.rooms[0].roomId);
  const rotatedKey = await C.newKey();
  const rotated = await request(app).post(`/owner/guest-shares/${share.shareId}/keys`).send({
    guestId,
    rooms: snapshots((await request(app).get('/guest/workspace').set('Cookie', cookies)).body.rooms),
    envelopes: [
      { roomId: rotatingRoom.roomId, keyVersion: rotatingRoom.keyVersion + 1, principal: `user:${owner.userId}`, wrappedKey: await C.wrap(rotatedKey, identities.owner.publicKey) },
      { roomId: rotatingRoom.roomId, keyVersion: rotatingRoom.keyVersion + 1, principal: `agent:${rotatingRoom.agentId}`, wrappedKey: await C.wrap(rotatedKey, rotatingRoom.agentId === agents[0] ? identities.first.publicKey : identities.second.publicKey) },
      { roomId: rotatingRoom.roomId, keyVersion: rotatingRoom.keyVersion + 1, principal: `guest:${guestId}`, wrappedKey: await C.wrap(rotatedKey, identities.guest.publicKey) }
    ]
  });
  expect(rotated.status).toBe(200);
  expect(rotated.body.rooms.find(room => room.roomId === rotatingRoom.roomId)).toEqual(expect.objectContaining({ keyVersion: rotatingRoom.keyVersion + 1, rotationRequired: false, status: 'active' }));
  for (const room of pending.body.rooms) {
    const access = await guest.currentGuestAccess({
      sessionId: cookies[0].match(/guest_sid=([^;]+)/)[1].split('.')[0],
      sessionTokenHash: require('../../src/middleware/guestAuthMiddleware').tokenHash(decodeURIComponent(cookies[0].match(/guest_sid=([^;]+)/)[1].split('.')[1])),
      roomId: room.roomId
    });
    expect(access.member.status).toBe('active');
  }
  await expect(guest.currentGuestAccess({
    sessionId: cookies[0].match(/guest_sid=([^;]+)/)[1].split('.')[0],
    sessionTokenHash: require('../../src/middleware/guestAuthMiddleware').tokenHash(decodeURIComponent(cookies[0].match(/guest_sid=([^;]+)/)[1].split('.')[1])),
    roomId: uid()
  })).rejects.toMatchObject({ status: 404 });

  const readyRoom = pending.body.rooms.find(room => room.roomId !== rotatingRoom.roomId);
  const roomContext = await request(app).get(`/guest/rooms/${readyRoom.roomId}`).set('Cookie', cookies);
  expect(roomContext.status).toBe(200);
  expect(roomContext.body.member).toEqual(expect.objectContaining({ kind: 'guest', id: guestId, status: 'active' }));
  expect(roomContext.body.guests).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'guest', id: guestId, displayName: 'Encrypted guest' })
  ]));
  const fileId = uid();
  const fileBytes = Buffer.alloc(40, 3);
  const uploaded = await request(app).post(`/guest/rooms/${readyRoom.roomId}/files`)
    .set('Cookie', cookies)
    .set('x-guest-csrf', unlocked.body.csrfToken)
    .field('id', fileId)
    .field('keyVersion', String(readyRoom.keyVersion))
    .attach('file', fileBytes, 'encrypted.bin');
  expect(uploaded.status).toBe(200);
  const messageId = uid();
  const messageBody = {
    id: messageId,
    keyVersion: readyRoom.keyVersion,
    payload: { v: 1, iv: '1234567890123456', data: 'YWJjZGVmZ2hpamtsbW5vcA==' },
    fileIds: [fileId],
    addressedToPrincipals: [],
    replyTo: []
  };
  const csrfDenied = await request(app).post(`/guest/rooms/${readyRoom.roomId}/messages`).set('Cookie', cookies).send(messageBody);
  expect(csrfDenied.status).toBe(403);
  const sent = await request(app).post(`/guest/rooms/${readyRoom.roomId}/messages`)
    .set('Cookie', cookies)
    .set('x-guest-csrf', unlocked.body.csrfToken)
    .send(messageBody);
  expect(sent.status).toBe(200);
  const replay = await request(app).post(`/guest/rooms/${readyRoom.roomId}/messages`)
    .set('Cookie', cookies)
    .set('x-guest-csrf', unlocked.body.csrfToken)
    .send(messageBody);
  expect(replay.status).toBe(200);
  expect(replay.body.id).toBe(messageId);
  const history = await request(app).get(`/guest/rooms/${readyRoom.roomId}/messages?after=0`).set('Cookie', cookies);
  expect(history.status).toBe(200);
  expect(history.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, sender_guest_id: guestId })]));
  const downloaded = await request(app).get(`/guest/rooms/${readyRoom.roomId}/files/${fileId}`).set('Cookie', cookies);
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers['x-shared-key-version']).toBe(String(readyRoom.keyVersion));
  expect(downloaded.body).toEqual(fileBytes);
  const crossRoom = await request(app).get(`/guest/rooms/${uid()}/files/${fileId}`).set('Cookie', cookies);
  expect(crossRoom.status).toBe(404);
  const crossRoomUpload = await request(app).post(`/guest/rooms/${uid()}/files`)
    .set('Cookie', cookies)
    .set('x-guest-csrf', unlocked.body.csrfToken)
    .field('id', uid())
    .field('keyVersion', String(readyRoom.keyVersion))
    .attach('file', fileBytes, 'encrypted.bin');
  expect(crossRoomUpload.status).toBe(404);
  const read = await request(app).post(`/guest/rooms/${readyRoom.roomId}/read`)
    .set('Cookie', cookies)
    .set('x-guest-csrf', unlocked.body.csrfToken)
    .send({ seq: history.body[history.body.length - 1].seq });
  expect(read.status).toBe(200);
  const deleted = await request(app).delete(`/guest/rooms/${readyRoom.roomId}/messages/${messageId}`)
    .set('Cookie', cookies)
    .set('x-guest-csrf', unlocked.body.csrfToken);
  expect(deleted.status).toBe(200);
  const outside = await request(app).get(`/guest/rooms/${uid()}`).set('Cookie', cookies);
  expect(outside.status).toBe(404);
});

test('owner authorization and guest key completeness fail closed', async () => {
  const unlocked = await request(app).post('/guest/unlock').send({ linkSecret: share.linkSecret, displayName: 'Guest' });
  const cookies = unlocked.headers['set-cookie'];
  const workspace = await request(app).get('/guest/workspace').set('Cookie', cookies);
  const guestId = unlocked.body.guest.guestId;
  await request(app).put('/guest/identity').set('Cookie', cookies).set('x-guest-csrf', unlocked.body.csrfToken).send({ publicKey: identities.guest.publicKey });
  const one = workspace.body.rooms[0];
  const key = await C.newKey();
  const incomplete = await request(app).post(`/owner/guest-shares/${share.shareId}/keys`).send({
    guestId,
    rooms: snapshots(workspace.body.rooms),
    envelopes: [{
      roomId: one.roomId,
      keyVersion: one.keyVersion,
      principal: `guest:${guestId}`,
      wrappedKey: await C.wrap(key, identities.guest.publicKey)
    }]
  });
  expect(incomplete.status).toBe(409);
  const forbidden = await request(app).post(`/owner/guest-shares/${share.shareId}/keys`)
    .set('x-test-user', outsider.userId)
    .send({ guestId, envelopes: [], rooms: snapshots(workspace.body.rooms) });
  expect(forbidden.status).toBe(404);
  const noIdentity = await request(app).put('/guest/identity')
    .set('Cookie', cookies)
    .set('x-guest-csrf', unlocked.body.csrfToken)
    .send({ publicKey: identities.first.publicKey });
  expect(noIdentity.status).toBe(409);
});

test('common-room rotation retains account and guest keys, excludes removed guests, and rejects stale provisioning', async () => {
  const common = await guest.createOwnerShare(owner.userId, { agentIds: [agents[0]], roomMode: 'common' });
  const secondIdentity = await identityPair();
  const friendIdentity = await identityPair();
  const join = async (name, publicKey) => {
    const response = await request(app).post('/guest/unlock').send({ linkSecret: common.linkSecret, displayName: name });
    const cookies = response.headers['set-cookie'];
    const identity = await request(app).put('/guest/identity').set('Cookie', cookies)
      .set('x-guest-csrf', response.body.csrfToken).send({ publicKey });
    expect(identity.status).toBe(200);
    return { id: response.body.guest.guestId, cookies, rooms: identity.body.rooms };
  };
  const first = await join('First common guest', identities.guest.publicKey);
  const second = await join('Second common guest', secondIdentity.publicKey);
  const roomId = first.rooms[0].roomId;
  expect(second.rooms[0].roomId).toBe(roomId);
  await fixture.query(`INSERT INTO shared_identities(principal,public_key,display_name) VALUES($1,$2,'Registered friend')`, [`user:${outsider.userId}`, JSON.stringify(friendIdentity.publicKey)]);
  await fixture.query(`INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by)
    VALUES($1,$2,'participant','active',$3)`, [roomId, outsider.userId, owner.userId]);
  const recipients = [
    [`user:${owner.userId}`, identities.owner.publicKey], [`agent:${agents[0]}`, identities.first.publicKey],
    [`user:${outsider.userId}`, friendIdentity.publicKey], [`guest:${first.id}`, identities.guest.publicKey],
    [`guest:${second.id}`, secondIdentity.publicKey]
  ];
  const envelopes = async (key, version, audience = recipients) => Promise.all(audience.map(async ([principal, publicKey]) => ({
    roomId, keyVersion: version, principal, wrappedKey: await C.wrap(key, publicKey)
  })));
  const roomSnapshot = async () => snapshots((await request(app).get('/guest/workspace').set('Cookie', second.cookies)).body.rooms);
  const original = await C.newKey();
  const initialRooms = await roomSnapshot();
  // A guest who opened the link but was not approved cannot receive keys.
  await expect(guest.provisionGuestKeys(owner.userId, common.shareId, {
    guestId: first.id, rooms: initialRooms, envelopes: await envelopes(original, 1)
  })).rejects.toMatchObject({ status: 403 });
  const shared = require('../../src/shared/service');
  expect((await shared.get(owner.userId, roomId)).guestRequests.map(item => item.guest_id).sort()).toEqual([first.id, second.id].sort());
  await shared.approveGuest(owner.userId, roomId, second.id);
  const approvedRooms = await roomSnapshot();
  initialRooms.splice(0, initialRooms.length, ...approvedRooms);
  await expect(guest.provisionGuestKeys(owner.userId, common.shareId, {
    guestId: first.id, rooms: initialRooms, envelopes: await envelopes(original, 1, recipients.filter(([id]) => id !== `user:${outsider.userId}`))
  })).rejects.toMatchObject({ status: 409 });
  await guest.provisionGuestKeys(owner.userId, common.shareId, { guestId: first.id, rooms: initialRooms, envelopes: await envelopes(original, 1) });
  await expect(guest.provisionGuestKeys(owner.userId, common.shareId, {
    guestId: second.id, rooms: initialRooms, envelopes: await envelopes(await C.newKey(), 1)
  })).rejects.toMatchObject({ status: 409 });
  await guest.provisionGuestKeys(owner.userId, common.shareId, { guestId: second.id, rooms: await roomSnapshot(), envelopes: await envelopes(original, 1) });
  await guest.removeGuest(owner.userId, common.shareId, first.id);
  expect((await request(app).get(`/guest/rooms/${roomId}/messages`).set('Cookie', first.cookies)).status).toBe(401);
  const current = (await fixture.query('SELECT * FROM shared_conversations WHERE id=$1', [roomId])).rows[0];
  expect(current.rotation_required).toBe(true);
  expect((await fixture.query('SELECT principal FROM shared_key_envelopes WHERE conversation_id=$1 AND principal=$2', [roomId, `guest:${first.id}`])).rows).toHaveLength(0);
  const rotated = await C.newKey();
  const remaining = recipients.filter(([id]) => id !== `guest:${first.id}`);
  const rotation = await roomSnapshot();
  await expect(guest.provisionGuestKeys(owner.userId, common.shareId, {
    guestId: second.id, rooms: rotation, envelopes: await envelopes(rotated, 2, remaining.filter(([id]) => id !== `user:${outsider.userId}`))
  })).rejects.toMatchObject({ status: 409 });
  await expect(guest.provisionGuestKeys(owner.userId, common.shareId, {
    guestId: second.id, rooms: rotation, envelopes: await envelopes(rotated, 2)
  })).rejects.toMatchObject({ status: 403 });
  await guest.provisionGuestKeys(owner.userId, common.shareId, { guestId: second.id, rooms: rotation, envelopes: await envelopes(rotated, 2, remaining) });
  const encrypted = await C.encrypt(rotated, { text: 'Remaining audience' }, `${roomId}:2`);
  for (const [principal, identity] of [[`user:${outsider.userId}`, friendIdentity], [`guest:${second.id}`, secondIdentity]]) {
    const wrapped = (await fixture.query('SELECT wrapped_key FROM shared_key_envelopes WHERE conversation_id=$1 AND key_version=2 AND principal=$2', [roomId, principal])).rows[0];
    expect((await C.decrypt(await C.unwrap(wrapped.wrapped_key, identity.pair.privateKey), encrypted, `${roomId}:2`)).text).toBe('Remaining audience');
  }
  await expect(C.decrypt(original, encrypted, `${roomId}:2`)).rejects.toThrow();

  // Registered-member provisioning must preserve the same guest audience.
  await fixture.query('UPDATE shared_conversations SET rotation_required=TRUE WHERE id=$1', [roomId]);
  const service = require('../../src/shared/service');
  const detail = await service.get(owner.userId, roomId);
  expect(detail.guests.map(member => member.guest_id)).toEqual([second.id]);
  const thirdKey = await C.newKey();
  const third = await envelopes(thirdKey, 3, remaining);
  const body = { keyVersion: 2, membershipVersion: detail.room.membership_version,
    envelopes: third.map(({ roomId: _room, ...envelope }) => envelope) };
  await expect(service.provision(owner.userId, roomId, { ...body, envelopes: body.envelopes.filter(item => item.principal !== `guest:${second.id}`) })).rejects.toMatchObject({ status: 409 });
  await expect(service.provision(owner.userId, roomId, body)).resolves.toEqual({ keyVersion: 3 });
});
