const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
  '051_retain_shared_task_attempts.sql',
  '052_bound_guest_file_storage.sql',
  '057_add_shared_message_recipients.sql',
  '053_bind_shared_action_approvals.sql'
].map(file => fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
const uid = () => crypto.randomUUID();
const hash = character => character.repeat(64);
const storageEnvironment = Object.fromEntries(['GUEST_FILE_STORAGE_MAX_BYTES', 'GUEST_FILE_STORAGE_MAX_FILES']
  .map(name => [name, process.env[name]]));
let fixture, service, authorization, guest, alice, bob, agent, room, share, session, guestId, sessionId, sessionTokenHash, runtimeId, device;

async function setup() {
  jest.resetModules();
  if (process.env.SHARED_TEST_DATABASE_URL) {
    const { Pool } = require('pg');
    const schemaName = 'guest_test_' + uid().replace(/-/g, '');
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
  if (process.env.SHARED_TEST_DATABASE_URL) for (const file of ['048_enforce_guest_room_relationships.sql', '049_retain_guest_history_attribution.sql']) {
    await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
  }
  jest.doMock('../../src/db/connection', () => ({
    query: fixture.query,
    getClient: async () => {
      const client = await fixture.pool.connect();
      if (!process.env.SHARED_TEST_DATABASE_URL) {
        // pg-mem cannot parse the lock's OF clause and does not enforce locks.
        // Real PostgreSQL above receives the exact production SQL; only that
        // suite establishes serialization/transaction evidence.
        const query = client.query.bind(client);
        client.query = (sql, values) => query(sql.replace(/FOR SHARE OF gs\b/g, 'FOR SHARE'), values);
      }
      return client;
    }
  }));
  guest = require('../../src/shared/guestService');
  service = require('../../src/shared/service');
  authorization = require('../../src/shared/authorization');
  alice = await seedUser(fixture.query, { email: 'guest-owner@example.test' });
  bob = await seedUser(fixture.query, { email: 'guest-member@example.test' });
  agent = uid();
  room = uid();
  share = uid();
  await fixture.query(`INSERT INTO agents(agent_id,user_id,agent_name,position,allowed_permissions)
    VALUES($1,$2,'Guest agent',0,'{}'::jsonb)`, [agent, alice.userId]);
  await fixture.query(`INSERT INTO shared_conversations(id,agent_id,owner_id,title)
    VALUES($1,$2,$3,'Guest room')`, [room, agent, alice.userId]);
  await fixture.query(`INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by)
    VALUES($1,$2,'owner','active',$2),($1,$3,'participant','active',$2)`, [room, alice.userId, bob.userId]);
  await fixture.query(`INSERT INTO guest_shares(share_id,owner_id,token_hash,room_mode)
    VALUES($1,$2,$3,'separate')`, [share, alice.userId, hash('t')]);
  await fixture.query(`INSERT INTO guest_share_agents(share_id,agent_id,room_id) VALUES($1,$2,$3)`, [share, agent, room]);
  const principal = await guest.createGuestPrincipal({
    shareId: share,
    displayName: 'Guest Reviewer',
    publicKey: {
      kty: 'RSA',
      n: 'n'.repeat(256)
    }
  });
  guestId = principal.guest_id;
  await fixture.query(`INSERT INTO guest_share_rooms(share_id,guest_id,agent_id,room_id) VALUES($1,$2,$3,$4)`, [share, guestId, agent, room]);
  await fixture.query(`INSERT INTO shared_identities(principal,public_key,display_name)
    VALUES($1,'{}'::jsonb,'Guest Reviewer'),($2,'{}'::jsonb,'Guest agent')`, [`guest:${guestId}`, `agent:${agent}`]);
  await fixture.query(`INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key)
    VALUES($1,1,$2,'wrapped'),($1,1,$3,'wrapped')`, [room, `guest:${guestId}`, `agent:${agent}`]);
  await guest.addGuestMember({ shareId: share, guestId, roomId: room, status: 'active' });
  sessionTokenHash = hash('s');
  session = await guest.createGuestSession({
    shareId: share,
    guestId,
    sessionTokenHash,
    expiresAt: new Date(Date.now() + 60_000)
  });
  sessionId = session.session_id;
  device = await authorization.createDevice(alice.userId, {
    agentId: agent,
    deviceLabel: 'Guest executor',
    platform: 'linux',
    executorType: 'container',
    workspaceAliases: ['Website'],
    capabilities: {
      actions: ['workspace.read'],
      resources: ['Website'],
      destinations: []
    }
  });
  runtimeId = uid();
  await service.registerRuntime(agent, {
    runtimeId,
    protocol: 2,
    deviceId: device.device_id,
    profiles: [{ provider: 'fixture', model: 'guest-context' }]
  });
}

beforeEach(setup);
afterEach(async () => {
  await fixture?.cleanup();
  for (const [name, value] of Object.entries(storageEnvironment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  jest.resetModules();
});

async function queuedGuestMessage(extra = {}) {
  return guest.insertGuestMessage({ sessionId, sessionTokenHash, roomId: room, body: {
    id: uid(), keyVersion: 1,
    payload: { v: 1, iv: '1234567890123456', data: 'YWJjZGVmZ2hpamtsbW5vcA==' },
    ...extra
  } });
}

async function withGuestClaims(fn) {
  const prior = process.env.FEATURE_GUEST_SHARING;
  process.env.FEATURE_GUEST_SHARING = 'true';
  try { return await fn(); }
  finally { if (prior === undefined) delete process.env.FEATURE_GUEST_SHARING; else process.env.FEATURE_GUEST_SHARING = prior; }
}

test('queued guest requests carry the authenticated share revision, ignoring supplied revisions', async () => {
  const message = await queuedGuestMessage({ guestShareRevision: 999 });
  expect(message.guest_share_revision).toBe(1);
  const replay = await guest.insertGuestMessage({ sessionId, sessionTokenHash, roomId: room, body: { id: message.id } });
  expect(replay.guest_share_revision).toBe(1);
});

async function guestGrant(roomId = room) {
  return authorization.createGrant(alice.userId, { agentId: agent, roomId, deviceId: device.device_id,
    granteeKind: 'guest', granteeId: guestId, workspaceAlias: 'Website', actions: ['workspace.read'],
    resources: ['Website'], destinations: [], budget: { maxRuntimeMs: 30000 } });
}
test('an owner guest grant claims only its authenticated guest and revocation denies subsequent actions', async () => withGuestClaims(async () => {
  const grant = await guestGrant();
  const queued = await queuedGuestMessage();
  const batch = await service.claim(agent, runtimeId);
  expect(batch.messages.map(message => message.id)).toEqual([queued.id]);
  expect(batch.context.request.requester).toEqual({ kind: 'guest', id: guestId });
  const tasks = require('../../src/shared/taskAuthority');
  const runtime = { agentId: agent, runtimeId };
  expect(await tasks.authorize(runtime, batch.id)).toMatchObject({ authorized: true });
  const list = await tasks.listGuest({ sessionId, sessionTokenHash }, room);
  expect(list).toEqual([expect.objectContaining({ task_id: batch.id, canCancel: true, actions: [] })]);
  await authorization.revokeGrant(alice.userId, grant.grant_id);
  expect(await tasks.authorize(runtime, batch.id)).toMatchObject({ authorized: false, state: 'cancellation_requested' });
}));
test.each(['expired share', 'revoked principal', 'removed member', 'removed agent', 'wrong room'])(
  'guest grant creation rejects %s', async boundary => withGuestClaims(async () => {
    let grantRoom = room;
    if (boundary === 'expired share') await fixture.query("UPDATE guest_shares SET expires_at=NOW()-INTERVAL '1 second' WHERE share_id=$1", [share]);
    if (boundary === 'revoked principal') await fixture.query("UPDATE guest_principals SET status='revoked' WHERE guest_id=$1", [guestId]);
    if (boundary === 'removed member') await fixture.query("UPDATE shared_guest_members SET status='removed' WHERE guest_id=$1", [guestId]);
    if (boundary === 'removed agent') await fixture.query('UPDATE guest_share_agents SET removed_at=NOW() WHERE share_id=$1', [share]);
    if (boundary === 'wrong room') {
      grantRoom = uid();
      await fixture.query('INSERT INTO shared_conversations(id,agent_id,owner_id,title) VALUES($1,$2,$3,$4)', [grantRoom, agent, alice.userId, 'Another room']);
    }
    await expect(guestGrant(grantRoom)).rejects.toMatchObject({ status: 403 });
  })
);
test('guest cancellation is scoped to a live session and queued cancellation consumes the request', async () => withGuestClaims(async () => {
  const message = await queuedGuestMessage();
  expect(await service.claim(agent, runtimeId)).toBeNull();
  const tasks = require('../../src/shared/taskAuthority');
  const taskId = (await fixture.query('SELECT task_id FROM shared_tasks WHERE first_message_id=$1', [message.id])).rows[0].task_id;
  await expect(tasks.cancel(null, taskId, { sessionId, sessionTokenHash: hash('x') })).rejects.toMatchObject({ status: 404 });
  expect(await tasks.cancel(null, taskId, { sessionId, sessionTokenHash })).toMatchObject({ state: 'cancellation_confirmed' });
  expect((await fixture.query('SELECT batch_id FROM shared_messages WHERE id=$1', [message.id])).rows[0].batch_id).toBeTruthy();
  await guestGrant();
  expect(await service.claim(agent, runtimeId)).toBeNull();
}));

test('guest queue capacity preserves idempotent retries and frees a slot after deleting queued work', async () => {
  const message = await queuedGuestMessage();
  for (let index = 1; index < 64; index++) await fixture.query(`INSERT INTO shared_messages
    (id,conversation_id,sender_guest_id,kind,payload,key_version,guest_share_revision)
    VALUES($1,$2,$3,'message',$4,1,1)`, [uid(), room, guestId, JSON.stringify(message.payload)]);
  await expect(queuedGuestMessage()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('64 requests') });
  const retry = await guest.insertGuestMessage({ sessionId, sessionTokenHash, roomId: room, body: { id: message.id } });
  expect(retry.id).toBe(message.id);
  await guest.removeGuestMessage({ sessionId, sessionTokenHash, roomId: room, messageId: message.id });
  await expect(queuedGuestMessage()).resolves.toMatchObject({ sender_guest_id: guestId });
});

test('an unsupported earlier requester cannot starve a later granted guest', async () => withGuestClaims(async () => {
  await fixture.query("INSERT INTO shared_identities(principal,public_key,display_name) VALUES($1,'{}','Bob')", [`user:${bob.userId}`]);
  await fixture.query("INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key) VALUES($1,1,$2,'wrapped')", [room, `user:${bob.userId}`]);
  await service.send(bob.userId, room, { id: uid(), keyVersion: 1,
    payload: { v: 1, iv: '1234567890123456', data: 'YWJjZGVmZ2hpamtsbW5vcA==' } });
  const queued = await queuedGuestMessage();
  await guestGrant();
  const batch = await service.claim(agent, runtimeId);
  expect(batch.messages.map(message => message.id)).toEqual([queued.id]);
  expect((await fixture.query("SELECT state FROM shared_tasks WHERE requester_id=$1", [bob.userId])).rows[0].state).toBe('unsupported_runtime');
}));

test('share revocation requests cancellation for waiting approvals until the runner confirms absence', async () => withGuestClaims(async () => {
  await guestGrant(); await queuedGuestMessage();
  const batch = await service.claim(agent, runtimeId);
  await fixture.query("UPDATE shared_tasks SET state='waiting_for_approval' WHERE task_id=$1", [batch.id]);
  await guest.updateOwnerShare(alice.userId, share, { revoked: true });
  expect((await fixture.query('SELECT state,completed_at FROM shared_tasks WHERE task_id=$1', [batch.id])).rows[0]).toMatchObject({ state: 'cancellation_requested', completed_at: null });
}));

test.each(['expired share', 'revoked principal', 'removed agent', 'stale revision', 'legacy revision'])('claim rejects %s even while room membership remains active', async boundary => {
  const message = await queuedGuestMessage();
  if (boundary === 'expired share') await fixture.query("UPDATE guest_shares SET expires_at=NOW()-INTERVAL '1 second' WHERE share_id=$1", [share]);
  if (boundary === 'revoked principal') await fixture.query("UPDATE guest_principals SET status='revoked' WHERE guest_id=$1", [guestId]);
  if (boundary === 'removed agent') await fixture.query('UPDATE guest_share_agents SET removed_at=NOW() WHERE share_id=$1 AND agent_id=$2', [share, agent]);
  if (boundary === 'stale revision') await fixture.query('UPDATE guest_shares SET revision=revision+1 WHERE share_id=$1', [share]);
  if (boundary === 'legacy revision') await fixture.query('UPDATE shared_messages SET guest_share_revision=NULL WHERE id=$1', [message.id]);
  await withGuestClaims(async () => {
    expect(await service.claim(agent, runtimeId)).toBeNull();
    expect((await fixture.query('SELECT task_id FROM shared_tasks WHERE first_message_id=$1', [message.id])).rows).toHaveLength(0);
  });
  expect((await fixture.query('SELECT payload,batch_id FROM shared_messages WHERE id=$1', [message.id])).rows[0]).toMatchObject({ payload: message.payload, batch_id: null });
});

test.each([{ password: 'Changed password 2026' }, { replaceLink: true }, { expiresAt: new Date(Date.now() + 120000).toISOString() }, { revoked: true }])('share change %j invalidates queued tasks without deleting their history', async change => {
  const message = await queuedGuestMessage();
  await withGuestClaims(() => service.claim(agent, runtimeId));
  const task = (await fixture.query('SELECT * FROM shared_tasks WHERE first_message_id=$1', [message.id])).rows[0];
  expect(task.state).toBe('unsupported_runtime');
  await guest.updateOwnerShare(alice.userId, share, change);
  const cancelled = (await fixture.query('SELECT state,current_authorization,completed_at FROM shared_tasks WHERE task_id=$1', [task.task_id])).rows[0];
  expect(cancelled.state).toBe('cancellation_confirmed');
  expect(cancelled.current_authorization).toMatchObject({ state: 'revoked', shareId: share });
  expect(cancelled.completed_at).not.toBeNull();
  await withGuestClaims(() => service.claim(agent, runtimeId));
  expect((await fixture.query('SELECT id,payload FROM shared_messages WHERE id=$1', [message.id])).rows[0]).toEqual({ id: message.id, payload: message.payload });
});

test.each(['running', 'outcome_uncertain'])('guest removal retains %s execution evidence without claiming rollback', async state => {
  const message = await queuedGuestMessage();
  await withGuestClaims(() => service.claim(agent, runtimeId));
  const task = (await fixture.query('SELECT task_id FROM shared_tasks WHERE first_message_id=$1', [message.id])).rows[0];
  await fixture.query('UPDATE shared_tasks SET state=$2 WHERE task_id=$1', [task.task_id, state]);
  const action = uid(), receipt = { diagnostic: 'already-attempted', effectUnknown: true };
  await fixture.query(`INSERT INTO shared_task_actions(action_id,task_id,action_digest,action_name,approval_state,external_receipt)
    VALUES($1,$2,'fixture-digest','fixture.action','approved',$3)`, [action, task.task_id, JSON.stringify(receipt)]);
  await guest.removeGuest(alice.userId, share, guestId);
  expect((await fixture.query('SELECT state,completed_at FROM shared_tasks WHERE task_id=$1', [task.task_id])).rows[0]).toEqual({ state: state === 'running' ? 'cancellation_requested' : 'outcome_uncertain', completed_at: null });
  expect((await fixture.query('SELECT approval_state,external_receipt FROM shared_task_actions WHERE action_id=$1', [action])).rows[0]).toEqual({ approval_state: 'revoked', external_receipt: receipt });
});

(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip)('share revision update and claim serialize on the same PostgreSQL lock', async () => {
  const message = await queuedGuestMessage(), client = await fixture.pool.connect();
  let claimed;
  try {
    await client.query('BEGIN');
    await client.query('UPDATE guest_shares SET revision=revision+1 WHERE share_id=$1', [share]);
    let settled = false;
    claimed = withGuestClaims(() => service.claim(agent, runtimeId));
    claimed.finally(() => { settled = true; });
    let blocked = false;
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      // Read outside the holding transaction: pg_stat_activity snapshots would
      // otherwise keep the first observation while the claim starts waiting.
      const rows = (await fixture.query(`SELECT COUNT(*) AS n FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FOR SHARE OF gs%'`)).rows;
      if (Number(rows[0].n)) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true); expect(settled).toBe(false);
    await client.query('COMMIT');
    expect(await claimed).toBeNull();
    expect((await fixture.query('SELECT task_id FROM shared_tasks WHERE first_message_id=$1', [message.id])).rows).toHaveLength(0);
  } finally { await client.query('ROLLBACK'); client.release(); await claimed; }
});

(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip)('older guest schema blocks guest work while preserving registered protocol-2 claims', async () => {
  await queuedGuestMessage();
  await fixture.query('ALTER TABLE shared_messages DROP COLUMN guest_share_revision CASCADE');
  await withGuestClaims(async () => {
    expect(await service.claim(agent, runtimeId)).toBeNull();
    expect((await fixture.query('SELECT task_id FROM shared_tasks')).rows).toHaveLength(0);
    await authorization.createGrant(alice.userId, { agentId: agent, roomId: room, deviceId: device.device_id,
      granteeKind: 'user', granteeId: bob.userId, workspaceAlias: 'Website', actions: ['workspace.read'], resources: ['Website'], destinations: [] });
    const id = uid();
    await fixture.query(`INSERT INTO shared_messages(id,conversation_id,sender_user_id,kind,payload,key_version)
      VALUES($1,$2,$3,'message','{}',1)`, [id, room, bob.userId]);
    const result = await service.claim(agent, runtimeId);
    expect(result.messages.map(message => message.id)).toEqual([id]);
    expect(result.context.request.requester).toEqual({ kind: 'user', id: bob.userId });
  });
});

test('guest membership is typed, room-scoped and encrypted', async () => {
  const message = await guest.insertGuestMessage({
    sessionId,
    sessionTokenHash,
    roomId: room,
    body: {
      id: uid(),
      keyVersion: 1,
      payload: {
        v: 1,
        iv: '1234567890123456',
        data: 'YWJjZGVmZ2hpamtsbW5vcA=='
      },
      addressedToPrincipals: [{ kind: 'user', id: bob.userId }]
    }
  });
  expect(message).toMatchObject({
    sender_guest_id: guestId,
    sender_user_id: null,
    sender_agent_id: null,
    addressed_to: [bob.userId],
    addressed_to_principals: [{ kind: 'user', id: bob.userId }]
  });
  const history = await guest.guestHistory({ sessionId, sessionTokenHash, roomId: room });
  expect(history[0]).toMatchObject({
    id: message.id,
    sender_guest_id: guestId,
    display_name: 'Guest Reviewer'
  });
  expect((await service.history(alice.userId, room))[0]).toMatchObject({ sender_guest_id: guestId, display_name: 'Guest Reviewer' });
  await expect(guest.currentGuestAccess({
    sessionId,
    sessionTokenHash,
    roomId: uid()
  })).rejects.toMatchObject({ status: 404 });
});

test('guest workspace context exposes only its audience and supports replies, reads and own-message deletion', async () => {
  const context = await guest.guestRoomContext({
    sessionId,
    sessionTokenHash,
    roomId: room
  });
  expect(context.member).toMatchObject({ kind: 'guest', id: guestId, status: 'active' });
  expect(context.members.map(member => member.id)).toEqual(expect.arrayContaining([alice.userId, bob.userId]));
  expect(context.guests).toEqual([expect.objectContaining({ kind: 'guest', id: guestId, displayName: 'Guest Reviewer' })]);
  expect(context.keys).toHaveLength(1);

  const first = await guest.insertGuestMessage({
    sessionId,
    sessionTokenHash,
    roomId: room,
    body: {
      id: uid(),
      keyVersion: 1,
      payload: {
        v: 1,
        iv: '1234567890123456',
        data: 'YWJjZGVmZ2hpamtsbW5vcA=='
      },
      addressedToPrincipals: [],
      replyTo: []
    }
  });
  const reply = await guest.insertGuestMessage({
    sessionId,
    sessionTokenHash,
    roomId: room,
    body: {
      id: uid(),
      keyVersion: 1,
      payload: {
        v: 1,
        iv: '1234567890123456',
        data: 'YWJjZGVmZ2hpamtsbW5vcA=='
      },
      addressedToPrincipals: [],
      replyTo: [first.id]
    }
  });
  expect(reply.reply_to).toEqual([first.id]);
  const after = await guest.guestRead({ sessionId, sessionTokenHash, roomId: room, seq: reply.seq });
  expect(after.lastReadSeq).toBe(Number(reply.seq));
  await expect(guest.removeGuestMessage({ sessionId, sessionTokenHash, roomId: room, messageId: reply.id })).resolves.toEqual({ ok: true });
  await expect(guest.removeGuestMessage({ sessionId, sessionTokenHash, roomId: room, messageId: uid() })).rejects.toMatchObject({ status: 403 });
});

test('guest question answers are public-only and idempotent', async () => {
  const questionId = uid();
  await fixture.query(`INSERT INTO shared_messages
    (id,conversation_id,sender_agent_id,kind,payload,key_version,addressed_to,reply_to,addressed_to_principals)
    VALUES($1,$2,$3,'question',$4,1,'{}','{}','[]'::jsonb)`, [questionId, room, agent, JSON.stringify({
    v: 1,
    iv: '1234567890123456',
    data: 'YWJjZGVmZ2hpamtsbW5vcA=='
  })]);
  const body = {
    id: uid(),
    keyVersion: 1,
    payload: {
      v: 1,
      iv: '1234567890123456',
      data: 'YWJjZGVmZ2hpamtsbW5vcA=='
    }
  };
  const answer = await guest.answerGuestQuestion({ sessionId, sessionTokenHash, roomId: room, questionId, body });
  expect(answer.message).toMatchObject({ sender_guest_id: guestId, kind: 'answer', question_id: questionId });
  await expect(guest.answerGuestQuestion({ sessionId, sessionTokenHash, roomId: room, questionId: uid(), body })).rejects.toMatchObject({ status: 409 });
  const duplicate = await guest.answerGuestQuestion({ sessionId, sessionTokenHash, roomId: room, questionId, body: { ...body, id: uid() } });
  expect(duplicate.existing).toBe(true);
  await fixture.query(`UPDATE shared_messages SET addressed_to=$2 WHERE id=$1`, [questionId, [bob.userId]]);
  await expect(guest.answerGuestQuestion({ sessionId, sessionTokenHash, roomId: room, questionId, body: { ...body, id: uid() } })).rejects.toMatchObject({ status: 403 });
});

test('guest files are encrypted, room-bound, message-bound and quota-limited', async () => {
  const bytes = Buffer.alloc(40, 7);
  const orphan = uid();
  await expect(guest.putGuestFile({ sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id: orphan, bytes })).resolves.toEqual({ id: orphan });
  await expect(guest.removeGuestFile({ sessionId, sessionTokenHash, roomId: room, id: orphan })).resolves.toEqual({ ok: true });
  await expect(guest.getGuestFile({ sessionId, sessionTokenHash, roomId: room, id: orphan })).rejects.toMatchObject({ status: 404 });

  const fileIds = [];
  for (let index = 0; index < 10; index += 1) {
    const id = uid();
    fileIds.push(id);
    await guest.putGuestFile({ sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id, bytes });
  }
  const message = await guest.insertGuestMessage({
    sessionId,
    sessionTokenHash,
    roomId: room,
    body: {
      id: uid(),
      keyVersion: 1,
      payload: { v: 1, iv: '1234567890123456', data: 'YWJjZGVmZ2hpamtsbW5vcA==' },
      fileIds: [fileIds[0]],
      addressedToPrincipals: []
    }
  });
  const downloaded = await guest.getGuestFile({ sessionId, sessionTokenHash, roomId: room, id: fileIds[0] });
  expect(downloaded.bytes).toEqual(bytes);
  expect(message.id).toBeTruthy();
  await expect(guest.getGuestFile({ sessionId, sessionTokenHash, roomId: uid(), id: fileIds[0] })).rejects.toMatchObject({ status: 404 });
  await expect(guest.putGuestFile({ sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id: uid(), bytes })).rejects.toMatchObject({ status: 409 });
  await guest.revokeGuestSession(sessionId);
  await expect(guest.getGuestFile({ sessionId, sessionTokenHash, roomId: room, id: fileIds[0] })).rejects.toMatchObject({ status: 404 });
});

async function uploadFromAnotherOwner() {
  const otherAgent = uid(), otherRoom = uid(), otherShare = uid();
  await fixture.query(`INSERT INTO agents(agent_id,user_id,agent_name,position,allowed_permissions)
    VALUES($1,$2,'Other owner agent',0,'{}')`, [otherAgent, bob.userId]);
  await fixture.query(`INSERT INTO shared_conversations(id,agent_id,owner_id,title)
    VALUES($1,$2,$3,'Other owner room')`, [otherRoom, otherAgent, bob.userId]);
  await fixture.query(`INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by)
    VALUES($1,$2,'owner','active',$2)`, [otherRoom, bob.userId]);
  await fixture.query(`INSERT INTO guest_shares(share_id,owner_id,token_hash,room_mode)
    VALUES($1,$2,$3,'common')`, [otherShare, bob.userId, hash('o')]);
  await fixture.query('INSERT INTO guest_share_agents(share_id,agent_id,room_id) VALUES($1,$2,$3)', [otherShare, otherAgent, otherRoom]);
  const other = await guest.createGuestPrincipal({ shareId: otherShare, displayName: 'Other guest', publicKey: { kty: 'RSA', n: 'n'.repeat(256) } });
  await fixture.query('INSERT INTO guest_share_rooms(share_id,guest_id,agent_id,room_id) VALUES($1,$2,$3,$4)', [otherShare, other.guest_id, otherAgent, otherRoom]);
  const principal = `guest:${other.guest_id}`;
  await fixture.query("INSERT INTO shared_identities(principal,public_key,display_name) VALUES($1,'{}','Other guest')", [principal]);
  await fixture.query("INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key) VALUES($1,1,$2,'wrapped')", [otherRoom, principal]);
  await guest.addGuestMember({ shareId: otherShare, guestId: other.guest_id, roomId: otherRoom, status: 'active' });
  const otherSession = await guest.createGuestSession({ shareId: otherShare, guestId: other.guest_id, sessionTokenHash: hash('t'), expiresAt: new Date(Date.now() + 60_000) });
  return { sessionId: otherSession.session_id, sessionTokenHash: hash('t'), roomId: otherRoom, keyVersion: 1 };
}

test('aggregate guest storage bounds bytes and files across owners while retaining authorized downloads and removal', async () => {
  process.env.GUEST_FILE_STORAGE_MAX_BYTES = '80';
  process.env.GUEST_FILE_STORAGE_MAX_FILES = '2';
  const first = { sessionId, sessionTokenHash, roomId: room, keyVersion: 1 }, other = await uploadFromAnotherOwner();
  const firstId = uid(), otherId = uid();
  await guest.putGuestFile({ ...first, id: firstId, bytes: Buffer.alloc(40, 7) });
  await guest.putGuestFile({ ...other, id: otherId, bytes: Buffer.alloc(40, 8) });
  await expect(guest.putGuestFile({ ...first, id: uid(), bytes: Buffer.alloc(29) })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('storage quota') });
  await expect(guest.getGuestFile({ ...other, id: firstId })).rejects.toMatchObject({ status: 404 });
  expect((await guest.getGuestFile({ ...first, id: firstId })).bytes).toEqual(Buffer.alloc(40, 7));
  await guest.removeGuestFile({ ...first, id: firstId });
  await guest.putGuestFile({ ...first, id: uid(), bytes: Buffer.alloc(40, 9) });
  process.env.GUEST_FILE_STORAGE_MAX_BYTES = '1000';
  await expect(guest.putGuestFile({ ...other, id: uid(), bytes: Buffer.alloc(29) })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('storage quota') });
  expect((await fixture.query("SELECT id FROM shared_files WHERE uploader LIKE 'guest:%'")).rows).toHaveLength(2);
});

test('idempotent retries and shrinking rekeys work at capacity; growing rekeys cannot bypass the quota', async () => {
  process.env.GUEST_FILE_STORAGE_MAX_BYTES = '80';
  const args = { sessionId, sessionTokenHash, roomId: room, keyVersion: 1 }, id = uid();
  await guest.putGuestFile({ ...args, id, bytes: Buffer.alloc(40, 7) });
  await guest.putGuestFile({ ...args, id: uid(), bytes: Buffer.alloc(40, 8) });
  await expect(guest.putGuestFile({ ...args, id, bytes: Buffer.alloc(80, 9) })).resolves.toEqual({ id });
  expect((await guest.getGuestFile({ ...args, id })).bytes).toEqual(Buffer.alloc(40, 7));
  await fixture.query('UPDATE shared_conversations SET key_version=2 WHERE id=$1', [room]);
  await fixture.query("INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key) VALUES($1,2,$2,'wrapped')", [room, `guest:${guestId}`]);
  await expect(guest.putGuestFile({ ...args, keyVersion: 2, id, bytes: Buffer.alloc(41, 9) })).rejects.toMatchObject({ status: 409 });
  expect((await fixture.query('SELECT key_version,bytes FROM shared_files WHERE id=$1', [id])).rows[0]).toMatchObject({ key_version: 1, bytes: Buffer.alloc(40, 7) });
  process.env.GUEST_FILE_STORAGE_MAX_BYTES = '60';
  await expect(guest.putGuestFile({ ...args, keyVersion: 2, id, bytes: Buffer.alloc(29, 9) })).resolves.toEqual({ id });
  expect((await guest.getGuestFile({ ...args, id })).bytes).toEqual(Buffer.alloc(29, 9));
});

test.each(['0', '-1', '1.5', '', 'Infinity', ' 80', '9007199254740992'])('invalid aggregate storage budget %j fails closed after authorization', async value => {
  process.env.GUEST_FILE_STORAGE_MAX_BYTES = value;
  await expect(guest.putGuestFile({ sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id: uid(), bytes: Buffer.alloc(40) })).rejects.toMatchObject({ status: 503 });
  await expect(guest.putGuestFile({ sessionId, sessionTokenHash, roomId: uid(), keyVersion: 1, id: uid(), bytes: Buffer.alloc(40) })).rejects.toMatchObject({ status: 404 });
  expect((await fixture.query('SELECT id FROM shared_files')).rows).toHaveLength(0);
});

(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip)('different owners concurrent PostgreSQL uploads cannot overbook global bytes; rollback releases capacity', async () => {
  process.env.GUEST_FILE_STORAGE_MAX_BYTES = '80';
  const first = { sessionId, sessionTokenHash, roomId: room, keyVersion: 1 }, other = await uploadFromAnotherOwner();
  const args = [{ ...first, id: uid(), bytes: Buffer.alloc(50, 7) }, { ...other, id: uid(), bytes: Buffer.alloc(50, 8) }];
  const results = await Promise.allSettled(args.map(arg => guest.putGuestFile(arg)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ status: 409 });
  const winner = results.findIndex(result => result.status === 'fulfilled'), loser = 1 - winner;
  expect(Number((await fixture.query("SELECT SUM(octet_length(bytes)) AS bytes FROM shared_files WHERE uploader LIKE 'guest:%'")).rows[0].bytes)).toBe(50);
  await guest.removeGuestFile(args[winner]);
  await expect(guest.putGuestFile(args[loser])).resolves.toEqual({ id: args[loser].id });
});

(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip)('aggregate guard migration is repeatable and independent guest uploads wait for its PostgreSQL lock', async () => {
  await fixture.query(migrations.at(-1));
  expect((await fixture.query('SELECT id FROM shared_guest_storage_guard')).rows).toEqual([{ id: 1 }]);
  const blocker = await fixture.pool.connect();
  let running;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM shared_guest_storage_guard WHERE id=1 FOR UPDATE');
    const id = uid();
    running = guest.putGuestFile({ sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id, bytes: Buffer.alloc(40) });
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting = (await fixture.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [blocker.processID])).rows[0].waiting;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    expect((await fixture.query('SELECT id FROM shared_files WHERE id=$1', [id])).rows).toHaveLength(0);
    await blocker.query('COMMIT');
    await expect(running).resolves.toEqual({ id });
  } finally {
    await blocker.query('ROLLBACK'); blocker.release(); await running?.catch(() => {});
  }
});

test('missing global guard denies guest uploads rather than using an unlocked fallback', async () => {
  await fixture.query('DELETE FROM shared_guest_storage_guard WHERE id=1');
  await expect(guest.putGuestFile({ sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id: uid(), bytes: Buffer.alloc(40) })).rejects.toMatchObject({ status: 503 });
  expect((await fixture.query('SELECT id FROM shared_files')).rows).toHaveLength(0);
});

(process.env.SHARED_TEST_DATABASE_URL ? test.each : test.skip.each)(['session', 'share'])('upload waiting for global admission cannot cross %s expiry', async boundary => {
  const expires = new Date(Date.now() + 2000);
  if (boundary === 'session') await fixture.query('UPDATE guest_sessions SET expires_at=$2 WHERE session_id=$1', [sessionId, expires]);
  else await fixture.query('UPDATE guest_shares SET expires_at=$2 WHERE share_id=$1', [share, expires]);
  const blocker = await fixture.pool.connect();
  let running;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM shared_guest_storage_guard WHERE id=1 FOR UPDATE');
    running = guest.putGuestFile({ sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id: uid(), bytes: Buffer.alloc(40) });
    const rejected = expect(running).rejects.toMatchObject({ status: 404 });
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting = (await fixture.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [blocker.processID])).rows[0].waiting;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expires.getTime() - Date.now()) + 30));
    await blocker.query('COMMIT'); await rejected;
    expect((await fixture.query('SELECT id FROM shared_files')).rows).toHaveLength(0);
  } finally {
    await blocker.query('ROLLBACK'); blocker.release(); await running?.catch(() => {});
  }
});

test('guest orphan cleanup preserves old registered-user files and linked guest history', async () => {
  process.env.GUEST_FILE_STORAGE_MAX_BYTES = '40';
  const args = { sessionId, sessionTokenHash, roomId: room, keyVersion: 1 }, orphan = uid(), registered = uid();
  await fixture.query(`INSERT INTO shared_files(id,conversation_id,uploader,key_version,bytes,created_at)
    VALUES($1,$3,$4,1,$5,$6),($2,$3,$7,1,$5,$6)`, [orphan, registered, room, `guest:${guestId}`, Buffer.alloc(40), new Date(Date.now() - 2 * 86400000), `user:${alice.userId}`]);
  const fresh = uid();
  await guest.putGuestFile({ ...args, id: fresh, bytes: Buffer.alloc(40, 7) });
  expect((await fixture.query('SELECT id FROM shared_files WHERE id=$1', [orphan])).rows).toHaveLength(0);
  expect((await fixture.query('SELECT id FROM shared_files WHERE id=$1', [registered])).rows).toHaveLength(1);
  await guest.insertGuestMessage({ ...args, body: { id: uid(), keyVersion: 1, payload: { v: 1, iv: '1234567890123456', data: 'YWJjZGVmZ2hpamtsbW5vcA==' }, fileIds: [fresh] } });
  await fixture.query('UPDATE shared_files SET created_at=$2 WHERE id=$1', [fresh, new Date(Date.now() - 2 * 86400000)]);
  await expect(guest.putGuestFile({ ...args, id: uid(), bytes: Buffer.alloc(29) })).rejects.toMatchObject({ status: 409 });
  expect((await fixture.query('SELECT message_id FROM shared_files WHERE id=$1', [fresh])).rows[0].message_id).toBeTruthy();
});

test('full guest storage does not block registered-user encrypted uploads', async () => {
  process.env.GUEST_FILE_STORAGE_MAX_BYTES = '40';
  await guest.putGuestFile({ sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id: uid(), bytes: Buffer.alloc(40) });
  await fixture.query("INSERT INTO shared_identities(principal,public_key,display_name) VALUES($1,'{}','Owner')", [`user:${alice.userId}`]);
  await fixture.query("INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key) VALUES($1,1,$2,'wrapped')", [room, `user:${alice.userId}`]);
  const id = uid();
  await expect(service.putFile(`user:${alice.userId}`, room, 1, id, Buffer.alloc(40, 9))).resolves.toEqual({ id });
  expect((await service.getFile(`user:${alice.userId}`, room, id)).bytes).toEqual(Buffer.alloc(40, 9));
});

test('guest identity replacement and account-like sender spoofing are rejected', async () => {
  await expect(guest.setGuestIdentity({
    shareId: share,
    guestId,
    publicKey: {
      kty: 'RSA',
      n: 'different'.repeat(32)
    }
  })).rejects.toMatchObject({ status: 409 });
  await expect(fixture.query(`INSERT INTO shared_messages
    (id,conversation_id,sender_user_id,sender_guest_id,kind,payload,key_version,addressed_to,reply_to)
    VALUES($1,$2,$3,$4,'message','{}'::jsonb,1,'{}','{}')`, [uid(), room, bob.userId, guestId])).rejects.toBeTruthy();
});

test('share revision and session revocation invalidate guest access', async () => {
  await fixture.query('UPDATE guest_shares SET revision=revision+1 WHERE share_id=$1', [share]);
  await expect(guest.currentGuestAccess({ sessionId, sessionTokenHash, roomId: room })).rejects.toMatchObject({ status: 404 });
  await fixture.query('UPDATE guest_shares SET revision=1 WHERE share_id=$1', [share]);
  await fixture.query('UPDATE guest_sessions SET revoked_at=NOW() WHERE session_id=$1', [sessionId]);
  await expect(guest.currentGuestAccess({ sessionId, sessionTokenHash, roomId: room })).rejects.toMatchObject({ status: 404 });
});

test('guest sender is retained as unsupported work instead of reaching a legacy runner', async () => {
  process.env.FEATURE_GUEST_SHARING = 'true';
  const message = await guest.insertGuestMessage({
    sessionId,
    sessionTokenHash,
    roomId: room,
    body: {
      id: uid(),
      keyVersion: 1,
      payload: {
        v: 1,
        iv: '1234567890123456',
        data: 'YWJjZGVmZ2hpamtsbW5vcA=='
      },
      addressedToPrincipals: []
    }
  });
  const batch = await service.claim(agent, runtimeId);
  expect(batch).toBeNull();
  const task = (await fixture.query('SELECT requester_kind,requester_id,state,execution_context FROM shared_tasks WHERE first_message_id=$1', [message.id])).rows[0];
  expect(task).toMatchObject({
    requester_kind: 'guest',
    requester_id: guestId,
    state: 'unsupported_runtime'
  });
  expect(task.execution_context.request.requester).toEqual({ kind: 'guest', id: guestId });
});

test('disabled guest sharing leaves queued guest work unclaimed', async () => {
  const message = await guest.insertGuestMessage({
    sessionId,
    sessionTokenHash,
    roomId: room,
    body: {
      id: uid(),
      keyVersion: 1,
      payload: {
        v: 1,
        iv: '1234567890123456',
        data: 'YWJjZGVmZ2hpamtsbW5vcA=='
      },
      addressedToPrincipals: []
    }
  });
  process.env.FEATURE_GUEST_SHARING = 'false';
  expect(await service.claim(agent, runtimeId)).toBeNull();
  expect((await fixture.query('SELECT batch_id FROM shared_messages WHERE id=$1', [message.id])).rows[0].batch_id).toBeNull();
  expect((await fixture.query('SELECT task_id FROM shared_tasks WHERE first_message_id=$1', [message.id])).rows).toHaveLength(0);
});

async function useTrustedRuntime() {
  await service.registerRuntime(agent, { runtimeId, protocol: 2, executionMode: 'trusted',
    profiles: [{ provider: 'fixture', model: 'guest-context' }] });
}
function trustedReply() {
  return { messages: [{ id: uid(), kind: 'message', keyVersion: 1,
    payload: { v: 1, iv: '1234567890123456', data: 'YWJjZGVmZ2hpamtsbW5vcA==' },
    addressedTo: [], addressedToPrincipals: [{ kind: 'guest', id: guestId }], replyTo: [], fileIds: [] }] };
}

test.each([false, true])('explicit uncertain guest retry preserves history and respects revocation=%s', async revoked => {
  await useTrustedRuntime();
  const message = await queuedGuestMessage();
  await withGuestClaims(async () => {
    const batch = await service.claim(agent, runtimeId);
    await service.release(agent, runtimeId, batch.id, true);
    if (revoked) await fixture.query("UPDATE guest_principals SET status='revoked' WHERE guest_id=$1", [guestId]);
    await service.control(alice.userId, room, { action: 'retry' });
    const stored = (await fixture.query('SELECT batch_id FROM shared_messages WHERE id=$1', [message.id])).rows[0];
    expect(stored.batch_id).toBe(revoked ? batch.id : null);
    const next = await service.claim(agent, runtimeId);
    if (revoked) expect(next).toBeNull();
    else expect(next.messages.map(item => item.id)).toEqual([message.id]);
  });
});

test('trusted guest messages run and publish without a device grant', async () => {
  await useTrustedRuntime();
  const message = await queuedGuestMessage();
  await withGuestClaims(async () => {
    const batch = await service.claim(agent, runtimeId);
    expect(batch.messages.map(item => item.id)).toEqual([message.id]);
    expect(batch.context.execution).toMatchObject({ mode: 'trusted', isolation: 'owner-trusted', executorId: null });
    expect(batch.context.request.requester).toEqual({ kind: 'guest', id: guestId });
    expect(batch.context.authorization).toMatchObject({ mode: 'trusted', grantId: null, shareId: share });
    const tasks = require('../../src/shared/taskAuthority');
    expect(await tasks.authorize({ agentId: agent, runtimeId }, batch.id)).toMatchObject({ authorized: true });
    await expect(tasks.propose({ agentId: agent, runtimeId }, batch.id, { actionId: uid(), name: 'workspace.read', resource: 'Website' }))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.finish(agent, runtimeId, batch.id, trustedReply())).resolves.toEqual({ ok: true });
    expect((await fixture.query('SELECT state,grant_id FROM shared_tasks WHERE task_id=$1', [batch.id])).rows[0])
      .toMatchObject({ state: 'completed', grant_id: null });
  });
});

test('trusted coding tasks can pass ten minutes while retaining their originally issued deadline', async () => {
  await useTrustedRuntime();
  await queuedGuestMessage();
  await withGuestClaims(async () => {
    const batch = await service.claim(agent, runtimeId);
    await fixture.query('UPDATE shared_tasks SET claimed_at=$2 WHERE task_id=$1', [batch.id, new Date(Date.now() - 1200000)]);
    const tasks = require('../../src/shared/taskAuthority');
    expect(await tasks.authorize({ agentId: agent, runtimeId }, batch.id)).toMatchObject({ authorized: true });

    const stored = (await fixture.query('SELECT execution_context FROM shared_tasks WHERE task_id=$1', [batch.id])).rows[0].execution_context;
    stored.authorization.budget.maxRuntimeMs = 600000;
    await fixture.query('UPDATE shared_tasks SET execution_context=$2 WHERE task_id=$1', [batch.id, JSON.stringify(stored)]);
    expect(await tasks.authorize({ agentId: agent, runtimeId }, batch.id)).toMatchObject({ authorized: false });
  });
});

test('trusted guest access revocation holds the result instead of publishing it', async () => {
  await useTrustedRuntime();
  await queuedGuestMessage();
  await withGuestClaims(async () => {
    const batch = await service.claim(agent, runtimeId);
    await fixture.query('UPDATE guest_shares SET revoked_at=NOW(),revision=revision+1 WHERE share_id=$1', [share]);
    await expect(service.finish(agent, runtimeId, batch.id, trustedReply())).rejects.toMatchObject({ status: 409 });
    const task = (await fixture.query('SELECT state,held_result FROM shared_tasks WHERE task_id=$1', [batch.id])).rows[0];
    expect(task.state).toBe('failed');
    expect(task.held_result.messages).toHaveLength(1);
    expect((await fixture.query('SELECT id FROM shared_messages WHERE batch_id=$1 AND sender_agent_id IS NOT NULL', [batch.id])).rows).toHaveLength(0);
  });
});

test('trusted sharing mode cannot be changed during a claimed turn', async () => {
  await useTrustedRuntime();
  await queuedGuestMessage();
  await withGuestClaims(async () => {
    const batch = await service.claim(agent, runtimeId);
    await expect(service.registerRuntime(agent, { runtimeId, protocol: 2, executionMode: 'restricted', deviceId: device.device_id,
      profiles: [{ provider: 'fixture', model: 'guest-context' }] })).rejects.toMatchObject({ status: 409 });
    expect(batch.context.execution.mode).toBe('trusted');
  });
});

test('turning guest sharing off stops authorizing an existing trusted task', async () => {
  await useTrustedRuntime();
  await queuedGuestMessage();
  const batch = await withGuestClaims(() => service.claim(agent, runtimeId));
  process.env.FEATURE_GUEST_SHARING = 'false';
  const tasks = require('../../src/shared/taskAuthority');
  await expect(tasks.authorize({ agentId: agent, runtimeId }, batch.id)).resolves.toMatchObject({ authorized: false, state: 'cancellation_requested' });
});

test('separate guest shares allocate an isolated room for each guest', async () => {
  const second = await guest.createGuestPrincipal({
    shareId: share,
    displayName: 'Second Guest'
  });
  const secondSessionTokenHash = hash('u');
  const secondSession = await guest.createGuestSession({
    shareId: share,
    guestId: second.guest_id,
    sessionTokenHash: secondSessionTokenHash,
    expiresAt: new Date(Date.now() + 60_000)
  });

  const firstWorkspace = await guest.guestWorkspace({ sessionId, sessionTokenHash });
  const secondWorkspace = await guest.guestWorkspace({
    sessionId: secondSession.session_id,
    sessionTokenHash: secondSessionTokenHash
  });
  expect(firstWorkspace.rooms).toHaveLength(1);
  expect(secondWorkspace.rooms).toHaveLength(1);
  expect(firstWorkspace.rooms[0].roomId).toBe(room);
  expect(secondWorkspace.rooms[0].roomId).not.toBe(room);
  await expect(guest.currentGuestAccess({
    sessionId: secondSession.session_id,
    sessionTokenHash: secondSessionTokenHash,
    roomId: room
  })).rejects.toMatchObject({ status: 404 });
});

test('045 migration is idempotent on PostgreSQL and preserves private account rows', async () => {
  if (process.env.SHARED_TEST_DATABASE_URL) await fixture.query(migrations[3]);
  const account = (await fixture.query('SELECT user_id FROM users WHERE user_id=$1', [alice.userId])).rows[0];
  expect(account.user_id).toBe(alice.userId);
  const tables = (await fixture.query(`SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('guest_shares','guest_share_agents','guest_principals','guest_sessions','shared_guest_members','guest_share_rooms')`)).rows;
  expect(new Set(tables.map(row => row.table_name))).toEqual(new Set(['guest_shares', 'guest_share_agents', 'guest_principals', 'guest_sessions', 'shared_guest_members', 'guest_share_rooms']));
});

test.each(['share', 'agent'])('%s removal revokes retained guest envelopes and requires room rotation', async kind => {
  if (kind === 'share') await guest.updateOwnerShare(alice.userId, share, { revoked: true });
  else {
    const replacement = uid();
    await fixture.query(`INSERT INTO agents(agent_id,user_id,agent_name,position,allowed_permissions)
      VALUES($1,$2,'Replacement shared agent',1,'{}'::jsonb)`, [replacement, alice.userId]);
    await guest.replaceShareAgents(alice.userId, share, { agentIds: [replacement] });
  }
  expect((await fixture.query('SELECT rotation_required FROM shared_conversations WHERE id=$1', [room])).rows[0].rotation_required).toBe(true);
  expect((await fixture.query('SELECT principal FROM shared_key_envelopes WHERE conversation_id=$1 AND principal=$2', [room, `guest:${guestId}`])).rows).toHaveLength(0);
  expect((await fixture.query('SELECT status FROM shared_guest_members WHERE conversation_id=$1 AND guest_id=$2', [room, guestId])).rows[0].status).toBe('removed');
  await expect(guest.currentGuestAccess({ sessionId, sessionTokenHash, roomId: room })).rejects.toMatchObject({ status: 404 });
});

test('rotation blocks direct guest messages, answers and replacement uploads', async () => {
  const fileId = uid();
  await guest.putGuestFile({ sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id: fileId, bytes: Buffer.alloc(40, 7) });
  await fixture.query('UPDATE shared_conversations SET rotation_required=TRUE WHERE id=$1', [room]);
  const body = { id: uid(), keyVersion: 1, payload: { v: 1, iv: '1234567890123456', data: 'YWJjZGVmZ2hpamtsbW5vcA==' } };
  await expect(guest.insertGuestMessage({ sessionId, sessionTokenHash, roomId: room, body })).rejects.toMatchObject({ status: 409, message: 'Conversation key rotation is required' });
  await expect(guest.answerGuestQuestion({ sessionId, sessionTokenHash, roomId: room, questionId: uid(), body })).rejects.toMatchObject({ status: 409, message: 'Conversation key rotation is required' });
  await expect(guest.putGuestFile({ sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id: fileId, bytes: Buffer.alloc(40, 9) })).rejects.toMatchObject({ status: 409 });
  expect((await fixture.query('SELECT bytes FROM shared_files WHERE id=$1', [fileId])).rows[0].bytes).toEqual(Buffer.alloc(40, 7));
});

(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip)('concurrent uploads cannot exceed the guest retained-file quota', async () => {
  const uploads = await Promise.allSettled(Array.from({ length: 12 }, () => guest.putGuestFile({
    sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id: uid(), bytes: Buffer.alloc(40, 7)
  })));
  expect(uploads.filter(result => result.status === 'fulfilled')).toHaveLength(10);
  const rejected = uploads.filter(result => result.status === 'rejected');
  expect(rejected).toHaveLength(2);
  expect(rejected.every(result => result.reason.status === 409 && result.reason.message.includes('quota'))).toBe(true);
  expect(Number((await fixture.query('SELECT COUNT(*) AS count FROM shared_files WHERE uploader=$1', [`guest:${guestId}`])).rows[0].count)).toBe(10);
});

(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip)('share revocation fences an upload transaction before bytes can be published', async () => {
  const blocker = await fixture.pool.connect();
  let running;
  try {
    await blocker.query('BEGIN');
    await blocker.query('UPDATE guest_shares SET revoked_at=NOW(),revision=revision+1 WHERE share_id=$1', [share]);
    running = guest.putGuestFile({ sessionId, sessionTokenHash, roomId: room, keyVersion: 1, id: uid(), bytes: Buffer.alloc(40, 7) });
    const rejected = expect(running).rejects.toMatchObject({ status: 404 });
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      blocked = (await fixture.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked`, [blocker.processID])).rows[0].blocked;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await blocker.query('COMMIT');
    await rejected;
    expect((await fixture.query('SELECT id FROM shared_files WHERE uploader=$1', [`guest:${guestId}`])).rows).toHaveLength(0);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await running?.catch(() => {});
  }
});

test('account answers respect typed guest and user targets and bind retries to their question', async () => {
  const payload = { v: 1, iv: '1234567890123456', data: 'YWJjZGVmZ2hpamtsbW5vcA==' };
  await fixture.query(`INSERT INTO shared_identities(principal,public_key,display_name) VALUES($1,'{}','Owner'),($2,'{}','Member') ON CONFLICT DO NOTHING`, [`user:${alice.userId}`, `user:${bob.userId}`]);
  await fixture.query(`INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key)
    VALUES($1,1,$2,'wrapped'),($1,1,$3,'wrapped')`, [room, `user:${alice.userId}`, `user:${bob.userId}`]);
  const guestQuestion = uid(), userQuestion = uid(), publicQuestion = uid();
  for (const [id, addressed] of [[guestQuestion, [{ kind: 'guest', id: guestId }]],
    [userQuestion, [{ kind: 'user', id: bob.userId }]], [publicQuestion, []]]) {
    await fixture.query(`INSERT INTO shared_messages(id,conversation_id,sender_agent_id,kind,payload,key_version,addressed_to_principals,addressed_to)
      VALUES($1,$2,$3,'question',$4,1,$5,$6)`, [id, room, agent, JSON.stringify(payload), JSON.stringify(addressed), []]);
  }
  for (const userId of [alice.userId, bob.userId]) {
    await expect(service.answer(userId, room, guestQuestion, { id: uid(), keyVersion: 1, payload })).rejects.toMatchObject({ status: 403 });
  }
  await guest.answerGuestQuestion({ sessionId, sessionTokenHash, roomId: room, questionId: guestQuestion,
    body: { id: uid(), keyVersion: 1, payload } });
  await expect(service.answer(alice.userId, room, userQuestion, { id: uid(), keyVersion: 1, payload })).rejects.toMatchObject({ status: 403 });
  const body = { id: uid(), keyVersion: 1, payload };
  expect((await service.answer(bob.userId, room, userQuestion, body)).message).toMatchObject({ question_id: userQuestion, sender_user_id: bob.userId });
  await expect(service.answer(bob.userId, room, userQuestion, body)).resolves.toMatchObject({ existing: true });
  await expect(service.answer(bob.userId, room, publicQuestion, body)).rejects.toMatchObject({ status: 409 });
  expect((await fixture.query('SELECT id FROM shared_messages WHERE question_id=$1', [publicQuestion])).rowCount).toBe(0);
});

test('agent typed replies target only current room members on protocol 2', async () => {
  const body = { id: uid(), kind: 'question', keyVersion: 1,
    payload: { v: 1, iv: '1234567890123456', data: 'YWJjZGVmZ2hpamtsbW5vcA==' },
    addressedToPrincipals: [{ kind: 'guest', id: guestId }] };
  const question = await service.agentSend(agent, room, body, runtimeId);
  expect(question).toMatchObject({ addressed_to: [], addressed_to_principals: [{ kind: 'guest', id: guestId }] });
  for (const targets of [null, 'everyone', [{ kind: 'user', id: uid() }], [{ kind: 'guest', id: uid() }], [{ kind: 'agent', id: agent }],
    [{ kind: 'guest', id: guestId }, { kind: 'user', id: bob.userId }]]) {
    await expect(service.agentSend(agent, room, { ...body, id: uid(), addressedToPrincipals: targets }, runtimeId)).rejects.toMatchObject({ status: 400 });
  }
  await expect(service.agentSend(agent, room, { ...body, id: uid(), addressedTo: [bob.userId] }, runtimeId)).rejects.toMatchObject({ status: 400 });
  await fixture.query("UPDATE shared_guest_members SET status='removed' WHERE conversation_id=$1 AND guest_id=$2", [room, guestId]);
  await expect(service.agentSend(agent, room, { ...body, id: uid() }, runtimeId)).rejects.toMatchObject({ status: 400 });
  await expect(service.registerRuntime(agent, { runtimeId, protocol: 1, profiles: [{ provider: 'fixture', model: 'legacy' }] })).rejects.toMatchObject({ status: 409 });
  expect((await fixture.query('SELECT protocol_version FROM shared_runtimes WHERE agent_id=$1', [agent])).rows[0].protocol_version).toBe(2);
  // Simulate a separately enrolled legacy runner; the public API cannot downgrade.
  await fixture.query('UPDATE shared_runtimes SET protocol_version=1,capabilities=$2 WHERE agent_id=$1', [agent, JSON.stringify({ protocol: 1 })]);
  await expect(service.agentSend(agent, room, { ...body, id: uid() }, runtimeId)).rejects.toMatchObject({ status: 409 });
});

test('agent delivery always includes the owner and excludes unselected users and guests from messages and files', async () => {
  const common = await guest.createOwnerShare(alice.userId, { roomMode: 'common', conversationId: room });
  const other = await guest.createGuestPrincipal({ shareId: common.shareId, displayName: 'Other guest', publicKey: { kty: 'RSA', n: 'n'.repeat(256) } });
  await guest.addGuestMember({ shareId: common.shareId, guestId: other.guest_id, roomId: room, status: 'active' });
  const otherHash = hash('o');
  const otherSession = await guest.createGuestSession({ shareId: common.shareId, guestId: other.guest_id, sessionTokenHash: otherHash, expiresAt: new Date(Date.now() + 60000) });
  const message = audience => ({ id: uid(), keyVersion: 1, payload: { v: 1, iv: '1234567890123456', data: 'YWJjZGVmZ2hpamtsbW5vcA==' }, audience });
  const ownerOnly = await service.agentSend(agent, room, { ...message({ mode: 'owner' }), kind: 'question' }, runtimeId);
  const selected = await service.agentSend(agent, room, message({ mode: 'selected', principals: [{ kind: 'guest', id: guestId }] }), runtimeId);
  const typed = await service.agentSend(agent, room, { ...message(undefined), addressedToPrincipals: [{ kind: 'guest', id: guestId }] }, runtimeId);
  const all = await service.agentSend(agent, room, message({ mode: 'all' }), runtimeId);
  expect(ownerOnly.recipient_principals).toEqual([{ kind: 'user', id: alice.userId }]);
  expect(selected.recipient_principals).toEqual([{ kind: 'user', id: alice.userId }, { kind: 'guest', id: guestId }]);
  expect(typed.recipient_principals).toEqual(selected.recipient_principals);
  expect((await service.history(alice.userId, room)).map(item => item.id)).toEqual([ownerOnly.id, selected.id, typed.id, all.id]);
  expect((await service.history(bob.userId, room)).map(item => item.id)).toEqual([all.id]);
  expect((await guest.guestHistory({ sessionId, sessionTokenHash, roomId: room })).map(item => item.id)).toEqual([selected.id, typed.id, all.id]);
  expect((await guest.guestHistory({ sessionId: otherSession.session_id, sessionTokenHash: otherHash, roomId: room })).map(item => item.id)).toEqual([all.id]);
  await expect(guest.answerGuestQuestion({ sessionId, sessionTokenHash, roomId: room, questionId: ownerOnly.id, body: message(undefined) })).rejects.toMatchObject({ status: 404 });
  const fileId = uid();
  await fixture.query('INSERT INTO shared_files(id,conversation_id,uploader,key_version,bytes,message_id) VALUES($1,$2,$3,1,$4,$5)', [fileId, room, `agent:${agent}`, Buffer.alloc(32), ownerOnly.id]);
  expect((await service.getFile(`user:${alice.userId}`, room, fileId)).id).toBe(fileId);
  await expect(service.getFile(`user:${bob.userId}`, room, fileId)).rejects.toMatchObject({ status: 404 });
  await expect(guest.getGuestFile({ sessionId, sessionTokenHash, roomId: room, id: fileId })).rejects.toMatchObject({ status: 404 });
  await expect(service.agentSend(agent, room, message({ mode: 'selected', principals: [{ kind: 'guest', id: uid() }] }), runtimeId)).rejects.toMatchObject({ status: 400 });
  await expect(service.agentSend(agent, room, message({ mode: 'owner', principals: [{ kind: 'guest', id: guestId }] }), runtimeId)).rejects.toMatchObject({ status: 400 });
  await fixture.query("INSERT INTO shared_identities(principal,public_key,display_name) VALUES($1,'{}','Owner')", [`user:${alice.userId}`]);
  await fixture.query("INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key) VALUES($1,1,$2,'wrapped')", [room, `user:${alice.userId}`]);
  const ownerAnswer = (await service.answer(alice.userId, room, ownerOnly.id, message(undefined))).message;
  expect(ownerAnswer.recipient_principals).toEqual(ownerOnly.recipient_principals);
  const guestQuestion = await service.agentSend(agent, room, { ...message({ mode: 'selected', principals: [{ kind: 'guest', id: guestId }] }), kind: 'question' }, runtimeId);
  const guestAnswer = (await guest.answerGuestQuestion({ sessionId, sessionTokenHash, roomId: room, questionId: guestQuestion.id, body: message(undefined) })).message;
  expect(guestAnswer.recipient_principals).toEqual(guestQuestion.recipient_principals);
  expect((await service.history(bob.userId, room)).map(item => item.id)).toEqual([all.id]);
  expect((await guest.guestHistory({ sessionId: otherSession.session_id, sessionTokenHash: otherHash, roomId: room })).map(item => item.id)).toEqual([all.id]);
  expect((await service.history(alice.userId, room)).map(item => item.id)).toContain(guestAnswer.id);
});

(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip)('the ordinary agent resolves an older common guest room while preserving its preparing private history', async () => {
  await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/054_add_agent_chat_threads.sql'), 'utf8'));
  const threads = require('../../src/shared/chatThreadService');
  const original = await threads.resolveAgentThread(alice.userId, agent);
  await fixture.query("UPDATE agent_chat_threads SET state='preparing' WHERE conversation_id=$1", [original.conversationId]);
  await guest.createOwnerShare(alice.userId, { roomMode: 'common', conversationId: room });
  // An active guest in the older room reproduces the live legacy-link mismatch.
  const commonId = (await fixture.query("SELECT share_id FROM guest_shares WHERE room_mode='common'")).rows[0].share_id;
  const person = await guest.createGuestPrincipal({ shareId: commonId, displayName: 'Legacy guest', publicKey: { kty: 'RSA', n: 'n'.repeat(256) } });
  await guest.addGuestMember({ shareId: commonId, guestId: person.guest_id, roomId: room, status: 'active' });
  const resolved = await threads.resolveAgentThread(alice.userId, agent);
  expect(resolved).toMatchObject({ conversationId: room, mode: 'shared', privateHistoryConversationId: original.conversationId });
  expect((await threads.listChatThreads(alice.userId)).filter(item => item.conversationId === room)).toHaveLength(1);
  expect(await threads.getChatContext(alice.userId, original.conversationId)).toMatchObject({ mode: 'private', state: 'preparing' });
  expect(await threads.getChatContext(alice.userId, room)).toMatchObject({ privateHistoryConversationId: original.conversationId });
  expect((await fixture.query('SELECT state,is_primary FROM agent_chat_threads WHERE conversation_id=$1', [original.conversationId])).rows[0]).toEqual({ state: 'preparing', is_primary: true });
});

test.each(['outcome_uncertain', 'cancellation_requested'])('trusted %s work automatically notifies its requester, releases the inbox, and is idempotent', async state => {
  await useTrustedRuntime();
  await queuedGuestMessage();
  await withGuestClaims(async () => {
    const batch = await service.claim(agent, runtimeId);
    await service.release(agent, runtimeId, batch.id, true);
    // Notification recovery must work even after the execution deadline expired.
    await fixture.query("UPDATE shared_tasks SET claimed_at=$2,state=$3 WHERE task_id=$1", [batch.id, new Date(Date.now() - 900000), state]);
    const body = { message: trustedReply().messages[0] };
    await expect(service.interrupt(agent, runtimeId, batch.id, body)).resolves.toEqual({ ok: true });
    await expect(service.interrupt(agent, runtimeId, batch.id, body)).resolves.toEqual({ ok: true, existing: true });
    expect((await fixture.query('SELECT execution_id,execution_uncertain FROM shared_runtimes WHERE agent_id=$1', [agent])).rows[0])
      .toMatchObject({ execution_id: null, execution_uncertain: false });
    expect((await fixture.query('SELECT state,current_authorization FROM shared_tasks WHERE task_id=$1', [batch.id])).rows[0])
      .toMatchObject({ state: 'failed', current_authorization: { state: 'interrupted', recovery: 'automatic' } });
    expect((await fixture.query('SELECT id FROM shared_messages WHERE id=$1', [body.message.id])).rows).toHaveLength(1);
    const next = await queuedGuestMessage();
    expect((await service.claim(agent, runtimeId)).messages.map(m => m.id)).toContain(next.id);
  });
});
test('a different runtime cannot automatically close an interrupted trusted task', async () => {
  await useTrustedRuntime(); await queuedGuestMessage();
  await withGuestClaims(async () => {
    const batch = await service.claim(agent, runtimeId);
    await expect(service.interrupt(agent, uid(), batch.id, { message: trustedReply().messages[0] }))
      .rejects.toMatchObject({ status: 409 });
    expect((await fixture.query('SELECT execution_id FROM shared_runtimes WHERE agent_id=$1', [agent])).rows[0].execution_id).toBe(batch.id);
  });
});
test('automatic interruption recovery rejects restricted runtimes', async () => {
  await useTrustedRuntime(); await queuedGuestMessage();
  await withGuestClaims(async () => {
    const batch = await service.claim(agent, runtimeId);
    await fixture.query('UPDATE shared_runtimes SET capabilities=$2 WHERE agent_id=$1', [agent, JSON.stringify({ executionMode: 'restricted' })]);
    await expect(service.interrupt(agent, runtimeId, batch.id, { message: trustedReply().messages[0] }))
      .rejects.toMatchObject({ status: 409 });
  });
});
test('interruption after a guest is revoked sends the notice only to the owner', async () => {
  await useTrustedRuntime(); await queuedGuestMessage();
  await withGuestClaims(async () => {
    const batch = await service.claim(agent, runtimeId);
    await fixture.query("UPDATE guest_principals SET status='revoked' WHERE guest_id=$1", [guestId]);
    const message = trustedReply().messages[0];
    await service.interrupt(agent, runtimeId, batch.id, { message });
    const saved = (await fixture.query('SELECT recipient_principals FROM shared_messages WHERE id=$1', [message.id])).rows[0];
    expect(saved.recipient_principals).toEqual([{ kind: 'user', id: alice.userId }]);
  });
});
