const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const {
  createTestDatabase,
  seedUser
} = require('../utils/pgMemTestUtils');
const C = require('../../public/js/shared-crypto');
const migration = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/042_add_shared_conversations.sql'), 'utf8');
const threadMigration = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/054_add_agent_chat_threads.sql'), 'utf8');
const historyImportMigration = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/055_add_shared_history_imports.sql'), 'utf8');
const invitationMigration = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/056_add_conversation_invitations.sql'), 'utf8');
let fixture, s, threads, historyImports, invitations, app, alice, bob, eve, agent, runtimeId, room, secondRoom, secondAgent, secondRuntimeId, unselectedAgent, key, pairs, account;
const uid = () => crypto.randomUUID();
async function setup() {
  jest.resetModules();
  if (process.env.SHARED_TEST_DATABASE_URL) {
    const {
      Pool
    } = require('pg');
    const schema = 'shared_test_' + uid().replace(/-/g, '');
    const admin = new Pool({
      connectionString: process.env.SHARED_TEST_DATABASE_URL
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.SHARED_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`
    });
    await pool.query(fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8'));
    fixture = {
      pool,
      query: (sql, args) => pool.query(sql, args),
      cleanup: async () => {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    };
  } else {
    // pg-mem's auto-generated FK indexes mis-handle intersected IS NULL filters.
    // PostgreSQL concurrency/rollback behavior is covered by the explicit real-DB run.
    const memory = require('pg-mem').newDb();
    memory.public.registerFunction({
      name: 'gen_random_uuid',
      returns: 'uuid',
      implementation: uid,
      impure: true
    });
    memory.public.none(fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8'));
    const {
      Pool
    } = memory.adapters.createPg();
    const pool = new Pool();
    fixture = {
      pool,
      query: (sql, args) => pool.query(sql, args),
      cleanup: () => pool.end()
    };
  }
  await fixture.query(migration);
  await fixture.query(threadMigration);
  await fixture.query(historyImportMigration);
  await fixture.query(invitationMigration);
  await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/057_add_shared_message_recipients.sql'), 'utf8'));
  await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/058_add_shared_agent_read_receipts.sql'), 'utf8'));
  jest.doMock('../../src/db/connection', () => ({
    query: fixture.query,
    getClient: () => fixture.pool.connect()
  }));
  s = require('../../src/shared/service');
  threads = require('../../src/shared/chatThreadService');
  historyImports = require('../../src/shared/chatHistoryImportService');
  invitations = require('../../src/shared/chatInvitationService');
  alice = await seedUser(fixture.query, {
    email: 'alice@example.test'
  });
  bob = await seedUser(fixture.query, {
    email: 'bob@example.test'
  });
  eve = await seedUser(fixture.query, {
    email: 'eve@example.test'
  });
  agent = uid();
  runtimeId = uid();
  secondAgent = uid();
  secondRuntimeId = uid();
  unselectedAgent = uid();
  const runtimeConfig = JSON.stringify({
    model_provider: 'fixture',
    model: 'test',
    sandbox_mode: 'none'
  });
  const allowedPermissions = JSON.stringify({
    keep: 'unchanged'
  });
  await fixture.query("INSERT INTO agents(agent_id,user_id,agent_name,position,runtime_config,allowed_permissions) VALUES($1,$2,$3,0,$4,$5),($6,$2,$7,1,$4,$5),($8,$2,$9,2,$4,$5)", [
    agent,
    alice.userId,
    'Shared Agent',
    runtimeConfig,
    allowedPermissions,
    secondAgent,
    'Second Shared Agent',
    unselectedAgent,
    'Unselected Agent'
  ]);
  for (const [index, u] of [alice, bob, eve].entries()) await s.registerIdentity('user:' + u.userId, {
    ...pairs[index],
    privateKey: await C.encrypt(account, {
      test: true
    }, 'fixture'),
    displayName: u.email.split('@')[0]
  });
  await s.registerIdentity('agent:' + agent, {
    publicKey: pairs[3].publicKey,
    displayName: 'Shared Agent'
  }, true);
  await s.registerIdentity('agent:' + secondAgent, {
    publicKey: pairs[4].publicKey,
    displayName: 'Second Shared Agent'
  }, true);
  await s.registerRuntime(agent, {
    runtimeId,
    protocol: 1,
    profiles: [{
      provider: 'fixture',
      model: 'test'
    }, {
      provider: 'fixture',
      model: 'other'
    }]
  });
  await s.registerRuntime(secondAgent, {
    runtimeId: secondRuntimeId,
    protocol: 1,
    profiles: [{
      provider: 'fixture',
      model: 'test'
    }]
  });
  room = await s.create(alice.userId, {
    agentId: agent,
    title: 'Shared work'
  });
  secondRoom = await s.create(alice.userId, {
    agentId: agent,
    title: 'Second shared work'
  });
  key = await C.newKey();
  await provision();
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      userId: req.headers['x-test-user'] || alice.userId
    };
    if (req.headers['x-credential-id']) req.authContext = {
      type: 'agent_token',
      agentId: agent,
      agentName: 'Shared Agent',
      credentialId: req.headers['x-credential-id']
    };
    next();
  });
  app.use('/shared', require('../../src/shared/routes').users);
  app.use('/chat-threads', require('../../src/shared/chatThreadRoutes'));
  app.use('/agent', require('../../src/shared/routes').agents);
  app.use((e, req, res, next) => res.status(e.status || 500).json({
    error: {
      message: e.message
    }
  }));
}
async function provision(rotation = false) {
  const d = await s.get(alice.userId, room.id);
  const shouldRotate = rotation || d.room.rotation_required;
  const version = d.room.key_version + (shouldRotate ? 1 : 0);
  const keys = new Map([[1, key]]);
  if (shouldRotate) keys.set(version, await C.newKey());
  const envelopes = [];
  for (const [v, k] of keys) {
    for (const m of d.members.filter(m => ['pending', 'active'].includes(m.status))) {
      envelopes.push({
        principal: 'user:' + m.user_id,
        keyVersion: v,
        wrappedKey: await C.wrap(k, m.public_key)
      });
    }
    envelopes.push({
      principal: 'agent:' + agent,
      keyVersion: v,
      wrappedKey: await C.wrap(k, pairs[3].publicKey)
    });
  }
  await s.provision(alice.userId, room.id, {
    membershipVersion: d.room.membership_version,
    keyVersion: d.room.key_version,
    envelopes
  });
  return keys;
}
async function join(role = 'manager') {
  await s.invite(alice.userId, room.id, {
    email: bob.email,
    role
  });
  await s.accept(bob.userId, room.id);
  await provision();
}
async function body(text, extra = {}) {
  return {
    id: uid(),
    keyVersion: 1,
    payload: await C.encrypt(key, {
      text
    }, room.id + ':1'),
    ...extra
  };
}
beforeAll(async () => {
  global.crypto = crypto.webcrypto;
  account = await C.newKey();
  pairs = await Promise.all([0, 1, 2, 3, 4].map(i => C.identity(account, 'fixture' + i)));
}, 30000);
beforeEach(setup);
afterEach(async () => {
  delete process.env.FEATURE_SHARED_CONVERSATIONS;
  delete process.env.FEATURE_IN_PLACE_AGENT_SHARING;
  await fixture?.cleanup();
  jest.resetModules();
});
test('migration can run twice and feature is disabled by default', async () => {
  if (process.env.SHARED_TEST_DATABASE_URL) await fixture.query(migration);
  delete process.env.FEATURE_SHARED_CONVERSATIONS;
  expect((await request(app).get('/shared')).status).toBe(404);
});
test('shared runner listings stay owner-scoped even when a member can see the conversation', async () => {
  const own = await request(app).get('/shared');
  expect(own.status).toBe(200);
  expect(own.body.agents.map(a => a.agent_id).sort()).toEqual([agent, secondAgent].sort());
  expect(own.body.agents.map(a => a.agent_id)).not.toContain(unselectedAgent);

  await join('participant');
  const member = await request(app).get('/shared').set('x-test-user', bob.userId);
  expect(member.status).toBe(200);
  expect(member.body.rooms.map(r => r.id)).toContain(room.id);
  expect(member.body.agents).toEqual([]);
  const outsider = await request(app).get('/shared').set('x-test-user', eve.userId);
  expect(outsider.status).toBe(200);
  expect(outsider.body.rooms).toEqual([]);
  expect(outsider.body.agents).toEqual([]);
});
test('creation rejects foreign, private-only and stale agents and accepts an owned live shared runner', async () => {
  await join('manager');
  const before = Number((await fixture.query('SELECT COUNT(*) AS total FROM shared_conversations')).rows[0].total);
  const foreign = await request(app).post('/shared').set('x-test-user', bob.userId).send({ agentId: agent, title: 'Foreign' });
  expect(foreign.status).toBe(409);
  const privateOnly = await request(app).post('/shared').send({ agentId: unselectedAgent, title: 'Private-only' });
  expect(privateOnly.status).toBe(409);
  await fixture.query('UPDATE shared_runtimes SET last_seen_at=$2 WHERE agent_id=$1', [agent, new Date(Date.now() - 120000)]);
  const offline = await request(app).post('/shared').send({ agentId: agent, title: 'Offline' });
  expect(offline.status).toBe(409);
  for (const denied of [foreign, privateOnly, offline]) expect(denied.body.error.message).toBe('Connect a shared-capable runner first');
  expect(Number((await fixture.query('SELECT COUNT(*) AS total FROM shared_conversations')).rows[0].total)).toBe(before);

  const created = await request(app).post('/shared').send({ agentId: secondAgent, title: 'Available' });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ agent_id: secondAgent, owner_id: alice.userId, title: 'Available' });
  expect((await fixture.query('SELECT role,status FROM shared_members WHERE conversation_id=$1 AND user_id=$2', [created.body.id, alice.userId])).rows).toEqual([{ role: 'owner', status: 'active' }]);
});
test('fixture covers selected and unselected agents plus owner, member and outsider identities', async () => {
  const agents = (await fixture.query('SELECT agent_id,agent_name FROM agents WHERE user_id=$1 ORDER BY position', [alice.userId])).rows;
  expect(agents.map(a => a.agent_id)).toEqual([agent, secondAgent, unselectedAgent]);
  expect(agents.map(a => a.agent_name)).toEqual(['Shared Agent', 'Second Shared Agent', 'Unselected Agent']);
  const rooms = (await fixture.query('SELECT id,agent_id,title FROM shared_conversations WHERE owner_id=$1 ORDER BY created_at', [alice.userId])).rows;
  expect(rooms).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: room.id,
      agent_id: agent,
      title: 'Shared work'
    }),
    expect.objectContaining({
      id: secondRoom.id,
      agent_id: agent,
      title: 'Second shared work'
    })
  ]));
  expect(rooms.every(r => r.agent_id !== unselectedAgent)).toBe(true);
  const identities = (await fixture.query("SELECT principal FROM shared_identities WHERE principal IN ($1,$2,$3)", [
    'user:' + alice.userId,
    'user:' + bob.userId,
    'user:' + eve.userId
  ])).rows.map(row => row.principal).sort();
  expect(identities).toEqual(['user:' + alice.userId, 'user:' + bob.userId, 'user:' + eve.userId].sort());
});
test('stable primary chat identity resolves idempotently and remains private until conversion', async () => {
  const first = await threads.resolveAgentThread(alice.userId, agent);
  const second = await threads.resolveAgentThread(alice.userId, agent);
  expect(first.conversationId).toBe(second.conversationId);
  expect(first).toMatchObject({ agentId: agent, ownerId: alice.userId, mode: 'private', state: 'private', role: 'owner' });
  expect(first.capabilities).toMatchObject({ read: true, send: true, manageAgent: true, manageAccess: false });
  const client = await fixture.pool.connect();
  await client.query('BEGIN');
  await expect(threads.assertPrivateThreadWritable(client, agent, alice.userId)).resolves.toBe(true);
  await client.query('COMMIT');
  await fixture.query("UPDATE agent_chat_threads SET state='preparing' WHERE conversation_id=$1", [first.conversationId]);
  await client.query('BEGIN');
  await expect(threads.assertPrivateThreadWritable(client, agent, alice.userId)).rejects.toMatchObject({ status: 409 });
  await client.query('ROLLBACK');
  client.release();
  await expect(threads.resolveAgentThread(bob.userId, agent)).rejects.toMatchObject({ status: 404 });
  expect((await threads.listChatThreads(alice.userId)).filter(row => row.agentId === agent && row.mode === 'private')).toHaveLength(1);
});
const realPostgresTest = process.env.SHARED_TEST_DATABASE_URL ? test : test.skip;
// pg-mem does not implement the combined ANY/IS NULL/audience selection accurately.
// Run receipt authorization and transactional assertions against disposable PostgreSQL.
realPostgresTest('server receipt stays delivered after participant reads and claim, then becomes agent-read', async () => {
  await join('participant');
  const source = await s.send(bob.userId, room.id, await body('Read receipt source'));
  const route = `/shared/${room.id}/message-status?ids=${source.id}`;
  expect((await request(app).get(route)).body).toEqual([{ messageId: source.id, serverReceived: true, readAt: null, deliveryState: 'delivered' }]);
  await s.read(alice.userId, room.id, source.seq);
  const claimed = await s.claim(agent, runtimeId);
  expect((await s.messageStatuses(bob.userId, room.id, [source.id]))[0].readAt).toBeNull();
  const receipt = await request(app).post(`/agent/batches/${claimed.id}/read`).set('x-agent-name', 'Shared Agent').set('x-shared-runtime', runtimeId).send({ messageIds: [source.id] });
  expect(receipt.status).toBe(200);
  expect(receipt.body.receiptStored).toBe(true);
  const status = (await s.messageStatuses(alice.userId, room.id, [source.id]))[0];
  expect(status).toMatchObject({ deliveryState: 'read', readAt: expect.any(String) });
  expect((await s.agentBatch(agent, runtimeId, claimed.id)).status).toBe('processing');
  await s.markBatchRead(agent, runtimeId, claimed.id, { messageIds: [source.id] });
  expect((await s.messageStatuses(bob.userId, room.id, [source.id]))[0].readAt).toBe(status.readAt);
  await s.release(agent, runtimeId, claimed.id, true);
  await s.control(alice.userId, room.id, { action: 'retry' });
  expect((await s.messageStatuses(alice.userId, room.id, [source.id]))[0].readAt).toBe(status.readAt);
});

realPostgresTest('read acknowledgements are restricted to the active runtime and exact batch sources', async () => {
  const source = await s.send(alice.userId, room.id, await body('Claimed'));
  const claimed = await s.claim(agent, runtimeId);
  const later = await s.send(alice.userId, room.id, await body('Not claimed'));
  await expect(s.markBatchRead(agent, uid(), claimed.id, { messageIds: [source.id] })).rejects.toMatchObject({ status: 409 });
  await expect(s.markBatchRead(secondAgent, secondRuntimeId, claimed.id, { messageIds: [source.id] })).rejects.toMatchObject({ status: 409 });
  await expect(s.markBatchRead(agent, runtimeId, claimed.id, { messageIds: [source.id, later.id] })).rejects.toMatchObject({ status: 404 });
  expect((await s.messageStatuses(alice.userId, room.id, [source.id, later.id])).every(item => item.readAt === null)).toBe(true);
  await s.finish(agent, runtimeId, claimed.id, { messages: [await body('Completed without optional ACK')] });
  expect((await s.messageStatuses(alice.userId, room.id, [source.id]))[0].deliveryState).toBe('read');
  await expect(s.markBatchRead(agent, runtimeId, claimed.id, { messageIds: [source.id] })).rejects.toMatchObject({ status: 409 });
});

realPostgresTest('receipt endpoints respect room access, audience, deletion and request bounds', async () => {
  await join('participant');
  const source = await s.send(alice.userId, room.id, await body('Owner-visible source'));
  await fixture.query('UPDATE shared_messages SET recipient_principals=$2 WHERE id=$1', [source.id, JSON.stringify([{ kind: 'user', id: alice.userId }])]);
  expect(await s.messageStatuses(bob.userId, room.id, [source.id])).toEqual([]);
  expect(await s.messageStatuses(alice.userId, secondRoom.id, [source.id])).toEqual([]);
  await expect(s.messageStatuses(eve.userId, room.id, [source.id])).rejects.toMatchObject({ status: 404 });
  await expect(s.messageStatuses(alice.userId, room.id, Array.from({ length: 101 }, uid))).rejects.toMatchObject({ status: 400 });
  await expect(s.messageStatuses(alice.userId, room.id, ['invalid'])).rejects.toMatchObject({ status: 400 });
  const visible = await s.messageStatuses(alice.userId, room.id, [source.id]);
  expect(Object.keys(visible[0]).sort()).toEqual(['deliveryState', 'messageId', 'readAt', 'serverReceived']);
  await s.removeMessage(alice.userId, room.id, source.id);
  expect(await s.messageStatuses(alice.userId, room.id, [source.id])).toEqual([]);
});

realPostgresTest('receipt migration backfills answered work only and is idempotent', async () => {
  const answered = await s.send(alice.userId, room.id, await body('Answered'));
  const skipped = await s.send(alice.userId, room.id, await body('Skipped'));
  for (const [message, status] of [[answered, 'answered'], [skipped, 'skipped']]) {
    const batchId = uid();
    await fixture.query('INSERT INTO shared_batches(id,conversation_id,agent_id,status) VALUES($1,$2,$3,$4)', [batchId, room.id, agent, status]);
    await fixture.query('UPDATE shared_messages SET batch_id=$2,agent_read_at=NULL WHERE id=$1', [message.id, batchId]);
  }
  const sql = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/058_add_shared_agent_read_receipts.sql'), 'utf8');
  await fixture.query(sql);
  const first = await s.messageStatuses(alice.userId, room.id, [answered.id, skipped.id]);
  expect(first.find(item => item.messageId === answered.id).deliveryState).toBe('read');
  expect(first.find(item => item.messageId === skipped.id).readAt).toBeNull();
  await fixture.query(sql);
  expect(await s.messageStatuses(alice.userId, room.id, [answered.id, skipped.id])).toEqual(first);
});
realPostgresTest('concurrent primary thread resolution returns one PostgreSQL binding', async () => {
  const resolved = await Promise.all(Array.from({ length: 8 }, () => threads.resolveAgentThread(alice.userId, agent)));
  expect(new Set(resolved.map(context => context.conversationId)).size).toBe(1);
  const rows = await fixture.query('SELECT conversation_id FROM agent_chat_threads WHERE agent_id=$1 AND is_primary=TRUE', [agent]);
  expect(rows.rows).toHaveLength(1);
});
test('feature-gated chat-thread routes return only the authenticated users contexts', async () => {
  const resolved = await request(app).post('/chat-threads/resolve').send({ agentId: agent });
  expect(resolved.status).toBe(200);
  expect(resolved.body).toMatchObject({ agentId: agent, ownerId: alice.userId, mode: 'private' });
  expect((await request(app).post('/chat-threads/resolve').set('x-test-user', bob.userId).send({ agentId: agent })).status).toBe(404);
  expect((await request(app).get('/chat-threads').set('x-test-user', bob.userId)).body).toEqual([]);
  const disabledApp = express();
  disabledApp.use((req, _res, next) => { req.user = { userId: alice.userId }; next(); });
  disabledApp.use('/chat-threads', require('../../src/shared/chatThreadRoutes'));
  delete process.env.FEATURE_IN_PLACE_AGENT_SHARING;
  expect((await request(disabledApp).post('/chat-threads/resolve').send({ agentId: agent })).status).toBe(404);
  expect((await request(disabledApp).get('/chat-threads/invitations/incoming')).status).toBe(404);
});
test('existing shared room adoption preserves its ID and exposes only member capabilities', async () => {
  await join('participant');
  const adopted = await threads.adoptExistingSharedThread(alice.userId, room.id);
  expect(adopted).toMatchObject({ conversationId: room.id, agentId: agent, mode: 'shared', role: 'owner' });
  const member = await threads.getChatContext(bob.userId, room.id);
  expect(member).toMatchObject({ conversationId: room.id, agentId: agent, mode: 'shared', role: 'participant' });
  expect(member.capabilities).toMatchObject({ read: true, send: true, manageAccess: false, manageAgent: false, stop: false });
  expect(JSON.stringify(member)).not.toMatch(/runtime_config|allowed_permissions|project_path|credential/i);
  await expect(threads.getChatContext(eve.userId, room.id)).rejects.toMatchObject({ status: 404 });
  await expect(threads.adoptExistingSharedThread(bob.userId, room.id)).rejects.toMatchObject({ status: 403 });
  const ownerRows = (await threads.listChatThreads(alice.userId)).filter(row => row.mode === 'shared' && row.agentId === agent);
  expect(ownerRows.map(row => row.conversationId).sort()).toEqual([room.id, secondRoom.id].sort());
  const listed = await threads.listChatThreads(bob.userId);
  expect(listed).toEqual([expect.objectContaining({ conversationId: room.id, mode: 'shared' })]);
});
test('pending shared membership remains shared context without read or send capability', async () => {
  await s.invite(alice.userId, room.id, { email: bob.email, role: 'participant' });
  const pending = await threads.getChatContext(bob.userId, room.id);
  expect(pending).toMatchObject({ conversationId: room.id, mode: 'shared', state: 'shared', membershipStatus: 'invited' });
  expect(pending.capabilities).toMatchObject({ read: false, send: false, upload: false, answer: false });
});
const postgresHistoryTest = process.env.SHARED_TEST_DATABASE_URL ? test : test.skip;
postgresHistoryTest('history source boundaries retain PostgreSQL microseconds when resumed', async () => {
  const binding = await threads.resolveAgentThread(alice.userId, agent);
  const sourceId = uid();
  await fixture.query(`INSERT INTO user_messages(user_message_id,agent_id,content,encrypted,created_at)
    VALUES($1,$2,'Saved within the boundary millisecond',FALSE,'2020-01-01T00:00:00.000800Z')`, [sourceId, agent]);
  const prepared = await historyImports.beginHistoryImport(alice.userId, binding.conversationId, uid());
  // Both values occupy one JavaScript millisecond, but PostgreSQL can order them.
  await fixture.query(`UPDATE shared_history_imports SET source_boundary='2020-01-01T00:00:00.000900Z' WHERE import_id=$1`, [prepared.importId]);
  expect((await historyImports.readImportSourcePage(alice.userId, prepared.importId)).items).toEqual([
    expect.objectContaining({ sourceId, content: 'Saved within the boundary millisecond' })
  ]);
});
postgresHistoryTest('history conversion waits for executing tasks and rolls back without fencing their private replies', async () => {
  const binding = await threads.resolveAgentThread(alice.userId, agent);
  const requestId = uid();
  await fixture.query('UPDATE agents SET is_working=TRUE WHERE agent_id=$1', [agent]);
  await expect(historyImports.beginHistoryImport(alice.userId, binding.conversationId, requestId)).rejects.toMatchObject({ status: 409 });
  expect(await threads.getChatContext(alice.userId, binding.conversationId)).toMatchObject({ state: 'private' });
  expect((await fixture.query('SELECT import_id FROM shared_history_imports WHERE request_id=$1', [requestId])).rows).toHaveLength(0);
  await fixture.query('UPDATE agents SET is_working=FALSE WHERE agent_id=$1', [agent]);
  await fixture.query('UPDATE shared_runtimes SET execution_id=$2 WHERE agent_id=$1', [agent, uid()]);
  await expect(historyImports.beginHistoryImport(alice.userId, binding.conversationId, requestId)).rejects.toMatchObject({ status: 409 });
  expect(await threads.getChatContext(alice.userId, binding.conversationId)).toMatchObject({ state: 'private' });
  await fixture.query('UPDATE shared_runtimes SET execution_id=NULL WHERE agent_id=$1', [agent]);
  const prepared = await historyImports.beginHistoryImport(alice.userId, binding.conversationId, requestId);
  await fixture.query('UPDATE agents SET is_working=TRUE WHERE agent_id=$1', [agent]);
  await expect(historyImports.activateSharedThread(alice.userId, prepared.importId, prepared.revision)).rejects.toMatchObject({ status: 409 });
  expect(await threads.getChatContext(alice.userId, binding.conversationId)).toMatchObject({ state: 'preparing' });
  await historyImports.abortHistoryImport(alice.userId, prepared.importId);
  expect(await threads.getChatContext(alice.userId, binding.conversationId)).toMatchObject({ state: 'private' });
});
postgresHistoryTest('history import resumes idempotently, excludes imported rows from dispatch, then atomically activates same chat', async () => {
  const binding = await threads.resolveAgentThread(alice.userId, agent);
  const oldOwnerMessage = uid();
  const oldAgentMessage = uid();
  await fixture.query('INSERT INTO user_messages(user_message_id,agent_id,content,encrypted) VALUES($1,$2,$3,FALSE)', [oldOwnerMessage, agent, 'private owner history']);
  await fixture.query("INSERT INTO messages(message_id,agent_id,message_type,content,encrypted) VALUES($1,$2,'message',$3,FALSE)", [oldAgentMessage, agent, 'private agent history']);
  const preview = await historyImports.previewShareHistory(alice.userId, binding.conversationId);
  expect(preview).toMatchObject({ conversationId: binding.conversationId, includedMessages: 2, excludedAttachments: 0 });
  const requestId = uid();
  const prepared = await historyImports.beginHistoryImport(alice.userId, binding.conversationId, requestId);
  expect(await historyImports.getActiveHistoryImport(alice.userId, binding.conversationId)).toMatchObject({
    importId: prepared.importId, state: 'importing', importedItems: 0, expectedItems: 2
  });
  expect(await historyImports.beginHistoryImport(alice.userId, binding.conversationId, requestId)).toMatchObject({ importId: prepared.importId, revision: prepared.revision });
  const page = await historyImports.readImportSourcePage(alice.userId, prepared.importId);
  const chunk = await Promise.all(page.items.map(async source => ({
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
    sourceFingerprint: source.sourceFingerprint,
    targetMessageId: uid(),
    keyVersion: 1,
    payload: await C.encrypt(key, { text: source.content }, binding.conversationId + ':1')
  })));
  const checkpoint = await historyImports.importHistoryChunk(alice.userId, prepared.importId, prepared.revision, chunk);
  expect(checkpoint).toMatchObject({ state: 'ready', importedItems: 2, expectedItems: 2 });
  expect(await historyImports.getActiveHistoryImport(alice.userId, binding.conversationId)).toMatchObject({
    importId: prepared.importId, state: 'ready', importedItems: 2
  });
  expect(await historyImports.importHistoryChunk(alice.userId, prepared.importId, prepared.revision, chunk)).toMatchObject({ state: 'ready', importedItems: 2 });
  await expect(s.agentHistory(agent, binding.conversationId, 0, runtimeId)).resolves.toHaveLength(2);
  await expect(s.claim(agent, runtimeId)).resolves.toBeNull();
  const activation = await Promise.all([
    historyImports.activateSharedThread(alice.userId, prepared.importId, prepared.revision),
    historyImports.activateSharedThread(alice.userId, prepared.importId, prepared.revision)
  ]);
  expect(activation.every(value => value.state === 'activated')).toBe(true);
  expect(await threads.getChatContext(alice.userId, binding.conversationId)).toMatchObject({ conversationId: binding.conversationId, mode: 'shared', state: 'shared' });
  const canonical = await s.history(alice.userId, binding.conversationId, 0);
  expect(canonical).toHaveLength(2);
  expect(canonical.map(row => row.dispatch_eligible)).toEqual([false, false]);
  expect((await historyImports.ownerPrivateHistory(alice.userId, binding.conversationId)).messages).toEqual([]);
});
postgresHistoryTest('private history is owner-only and paged in the shared chat without changing shared visibility', async () => {
  const privateId = uid();
  await fixture.query('INSERT INTO user_messages(user_message_id,agent_id,content,encrypted) VALUES($1,$2,$3,TRUE)', [privateId, agent, 'encrypted private image caption']);
  const attachmentId = uid();
  await fixture.query(`INSERT INTO attachments(attachment_id,content_type,file_name,size_bytes,storage_key,encrypted,agent_id,uploaded_by,iv_base64,auth_tag_base64)
    VALUES($1,'image/png','private.png',8,'private-fixture',TRUE,$2,'user','fixture-iv','fixture-tag')`, [attachmentId, agent]);
  await fixture.query('INSERT INTO user_message_attachments(user_message_id,attachment_id) VALUES($1,$2)', [privateId, attachmentId]);
  const page = await historyImports.ownerPrivateHistory(alice.userId, room.id);
  expect(page.messages).toEqual([expect.objectContaining({ messageId: privateId, encrypted: true,
    ownerPrivateHistory: true, sharedAudienceLabel: 'Owner only · private history' })]);
  expect(page.messages[0].attachments).toEqual([expect.objectContaining({ attachmentId,
    downloadUrl: `/api/user/attachments/${attachmentId}`,
    encryption: { alg: 'AES-GCM', ivBase64: 'fixture-iv', tagBase64: 'fixture-tag' } })]);
  expect((await historyImports.ownerPrivateHistory(alice.userId, room.id, page.nextOffset, page.boundary)).messages).toEqual([]);
  const olderId = uid();
  await fixture.query(`INSERT INTO user_messages(user_message_id,agent_id,content,encrypted,created_at)
    VALUES($1,$2,'Earlier private page',FALSE,NOW()-INTERVAL '1 day')`, [olderId, agent]);
  const smallPage = await historyImports.ownerPrivateHistory(alice.userId, room.id, 0, null, 1);
  expect(smallPage).toMatchObject({ hasMore: true, nextOffset: 1 });
  expect(smallPage.messages.map(message => message.messageId)).toEqual([privateId]);
  const olderPage = await historyImports.ownerPrivateHistory(alice.userId, room.id, smallPage.nextOffset, smallPage.boundary, 1);
  expect(olderPage.messages.map(message => message.messageId)).toEqual([olderId]);
  expect(olderPage.hasMore).toBe(false);
  await expect(historyImports.ownerPrivateHistory(alice.userId, room.id, 0, null, 201)).rejects.toMatchObject({ status: 400 });
  await join();
  await expect(historyImports.ownerPrivateHistory(bob.userId, room.id)).rejects.toMatchObject({ status: 403 });
  expect(await s.history(bob.userId, room.id, 0)).toHaveLength(0);
});
postgresHistoryTest('history import rejects stale source snapshots and abort restores the private binding', async () => {
  const binding = await threads.resolveAgentThread(alice.userId, agent);
  const sourceId = uid();
  await fixture.query('INSERT INTO user_messages(user_message_id,agent_id,content,encrypted) VALUES($1,$2,$3,FALSE)', [sourceId, agent, 'before snapshot']);
  const prepared = await historyImports.beginHistoryImport(alice.userId, binding.conversationId, uid());
  await fixture.query('UPDATE user_messages SET content=$2 WHERE user_message_id=$1', [sourceId, 'changed after snapshot']);
  await expect(historyImports.readImportSourcePage(alice.userId, prepared.importId)).rejects.toMatchObject({ status: 409 });
  expect(await historyImports.abortHistoryImport(alice.userId, prepared.importId)).toMatchObject({ conversationId: binding.conversationId, state: 'private' });
  expect(await threads.getChatContext(alice.userId, binding.conversationId)).toMatchObject({ mode: 'private', state: 'private' });
  expect((await fixture.query('SELECT id FROM shared_conversations WHERE id=$1', [binding.conversationId])).rows).toHaveLength(0);
});
postgresHistoryTest('conversion excludes archived history and preserves hidden model context for both sender types', async () => {
  for (const migrationName of ['014_add_archive_support.sql', '015_add_hidden_from_agent.sql', '016_add_hidden_from_agent_to_messages.sql']) {
    await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', migrationName), 'utf8'));
  }
  const binding = await threads.resolveAgentThread(alice.userId, agent);
  const visible = uid(), hiddenUser = uid(), archivedUser = uid(), hiddenAgent = uid(), archivedAgent = uid();
  await fixture.query(`INSERT INTO user_messages(user_message_id,agent_id,content,encrypted,hidden_from_agent)
    VALUES($1,$4,'visible',FALSE,FALSE),($2,$4,'hidden user',FALSE,TRUE),($3,$4,'archived user',FALSE,FALSE)`,
  [visible, hiddenUser, archivedUser, agent]);
  await fixture.query(`INSERT INTO messages(message_id,agent_id,message_type,content,encrypted,hidden_from_agent)
    VALUES($1,$3,'message','hidden agent',FALSE,TRUE),($2,$3,'message','archived agent',FALSE,FALSE)`, [hiddenAgent, archivedAgent, agent]);
  await fixture.query(`INSERT INTO archived_messages(user_message_id,message_id,agent_id,user_id,message_type)
    VALUES($1,NULL,$3,$4,'user_message'),(NULL,$2,$3,$4,'agent_message')`, [archivedUser, archivedAgent, agent, alice.userId]);
  await fixture.query("INSERT INTO user_messages(agent_id,content,encrypted) VALUES($1,'unrelated agent',FALSE)", [secondAgent]);
  expect(await historyImports.previewShareHistory(alice.userId, binding.conversationId)).toMatchObject({ includedMessages: 3, includedFiles: 0 });
  const prepared = await historyImports.beginHistoryImport(alice.userId, binding.conversationId, uid());
  const page = await historyImports.readImportSourcePage(alice.userId, prepared.importId);
  expect(new Set(page.items.map(item => item.sourceId))).toEqual(new Set([visible, hiddenUser, hiddenAgent]));
  const chunk = await Promise.all(page.items.map(async item => ({ ...item, targetMessageId: uid(), keyVersion: 1,
    payload: await C.encrypt(key, { text: item.content }, binding.conversationId + ':1') })));
  await historyImports.importHistoryChunk(alice.userId, prepared.importId, prepared.revision, chunk);
  await historyImports.activateSharedThread(alice.userId, prepared.importId, prepared.revision);
  expect(await s.history(alice.userId, binding.conversationId, 0)).toHaveLength(3);
  const modelHistory = await s.agentHistory(agent, binding.conversationId, 0, runtimeId);
  expect(modelHistory).toHaveLength(1);
  expect(modelHistory[0].id).toBe(chunk.find(item => item.sourceId === visible).targetMessageId);
  expect(await s.claim(agent, runtimeId)).toBeNull();
});
postgresHistoryTest('one source attachment referenced by multiple messages imports once and allows activation', async () => {
  const binding = await threads.resolveAgentThread(alice.userId, agent);
  const first = uid(), second = uid(), file = uid(), targetFile = uid();
  await fixture.query("INSERT INTO user_messages(user_message_id,agent_id,content,encrypted) VALUES($1,$3,'first',FALSE),($2,$3,'second',FALSE)", [first, second, agent]);
  await fixture.query(`INSERT INTO attachments(attachment_id,content_type,file_name,size_bytes,storage_key,encrypted,agent_id,uploaded_by)
    VALUES($1,'text/plain','reused.txt',4,'fixture',FALSE,$2,'user')`, [file, agent]);
  await fixture.query('INSERT INTO user_message_attachments(user_message_id,attachment_id) VALUES($1,$3),($2,$3)', [first, second, file]);
  expect(await historyImports.previewShareHistory(alice.userId, binding.conversationId)).toMatchObject({ includedMessages: 2, includedFiles: 1 });
  const prepared = await historyImports.beginHistoryImport(alice.userId, binding.conversationId, uid());
  expect(prepared.expectedFiles).toBe(1);
  await historyImports.importHistoryFile(alice.userId, prepared.importId, prepared.revision, file, targetFile, Buffer.alloc(32));
  const page = await historyImports.readImportSourcePage(alice.userId, prepared.importId);
  const chunk = await Promise.all(page.items.map(async item => ({ ...item, targetMessageId: uid(), keyVersion: 1, fileIds: [targetFile],
    payload: await C.encrypt(key, { text: item.content }, binding.conversationId + ':1') })));
  expect(await historyImports.importHistoryChunk(alice.userId, prepared.importId, prepared.revision, chunk)).toMatchObject({ state: 'ready', importedFiles: 1 });
  expect(await historyImports.activateSharedThread(alice.userId, prepared.importId, prepared.revision)).toMatchObject({ state: 'activated' });
});
postgresHistoryTest('a history chunk retry must keep the exact encrypted payload', async () => {
  const binding = await threads.resolveAgentThread(alice.userId, agent);
  await fixture.query("INSERT INTO user_messages(agent_id,content,encrypted) VALUES($1,'original',FALSE)", [agent]);
  const prepared = await historyImports.beginHistoryImport(alice.userId, binding.conversationId, uid());
  const source = (await historyImports.readImportSourcePage(alice.userId, prepared.importId)).items[0];
  const item = { ...source, targetMessageId: uid(), keyVersion: 1, payload: await C.encrypt(key, { text: source.content }, binding.conversationId + ':1') };
  await historyImports.importHistoryChunk(alice.userId, prepared.importId, prepared.revision, [item]);
  const conflicting = { ...item, payload: await C.encrypt(key, { text: 'different' }, binding.conversationId + ':1') };
  await expect(historyImports.importHistoryChunk(alice.userId, prepared.importId, prepared.revision, [conflicting])).rejects.toMatchObject({ status: 409 });
  expect(await historyImports.importHistoryChunk(alice.userId, prepared.importId, prepared.revision, [item])).toMatchObject({ state: 'ready', importedItems: 1 });
});
postgresHistoryTest('history request IDs stay conversation-bound and late source messages prevent activation', async () => {
  const binding = await threads.resolveAgentThread(alice.userId, agent);
  const other = await threads.resolveAgentThread(alice.userId, secondAgent);
  const requestId = uid();
  const attempts = await Promise.all(Array.from({ length: 4 }, () => historyImports.beginHistoryImport(alice.userId, binding.conversationId, requestId)));
  expect(new Set(attempts.map(item => item.importId)).size).toBe(1);
  await expect(historyImports.beginHistoryImport(alice.userId, other.conversationId, requestId)).rejects.toMatchObject({ status: 409 });
  await fixture.query("INSERT INTO user_messages(agent_id,content,encrypted) VALUES($1,'late private turn',FALSE)", [agent]);
  await expect(historyImports.activateSharedThread(alice.userId, attempts[0].importId, attempts[0].revision)).rejects.toMatchObject({ status: 409 });
  expect((await threads.getChatContext(alice.userId, binding.conversationId)).state).toBe('preparing');
});
postgresHistoryTest('preparing history cannot use legacy shared sends, invitations, uploads or runtime dispatch', async () => {
  const binding = await threads.resolveAgentThread(alice.userId, agent);
  await historyImports.beginHistoryImport(alice.userId, binding.conversationId, uid());
  await expect(s.invite(alice.userId, binding.conversationId, { email: bob.email })).rejects.toMatchObject({ status: 409 });
  await expect(s.send(alice.userId, binding.conversationId, await body('premature'))).rejects.toMatchObject({ status: 409 });
  await expect(s.putFile('user:' + alice.userId, binding.conversationId, 1, uid(), Buffer.alloc(32))).rejects.toMatchObject({ status: 409 });
  await fixture.query(`INSERT INTO shared_messages(id,conversation_id,sender_user_id,kind,payload,key_version)
    VALUES($1,$2,$3,'message',$4,1)`, [uid(), binding.conversationId, alice.userId, await C.encrypt(key, { text: 'legacy staged request' }, binding.conversationId + ':1')]);
  expect(await s.claim(agent, runtimeId)).toBeNull();
});
postgresHistoryTest('imported history does not consume the 64-request pending allowance', async () => {
  const payload = await C.encrypt(key, { text: 'historical' }, room.id + ':1');
  await fixture.query(`INSERT INTO shared_messages(id,conversation_id,sender_user_id,kind,payload,key_version,dispatch_eligible)
    SELECT gen_random_uuid(),$1,$2,'message',$3::jsonb,1,FALSE FROM generate_series(1,65)`, [room.id, alice.userId, JSON.stringify(payload)]);
  const requestMessage = await s.send(alice.userId, room.id, await body('one new request'));
  const batch = await s.claim(agent, runtimeId);
  expect(batch.messages.map(message => message.id)).toEqual([requestMessage.id]);
  expect((await fixture.query('SELECT COUNT(*)::int AS count FROM shared_messages WHERE conversation_id=$1 AND dispatch_eligible=FALSE AND batch_id IS NOT NULL', [room.id])).rows[0].count).toBe(0);
});
postgresHistoryTest('incremental history cursors return new rows and later tombstones without replaying the timeline', async () => {
  const message = await s.send(alice.userId, room.id, await body('remove me'));
  const beforeDelete = new Date(Date.now() - 5000).toISOString();
  await s.removeMessage(alice.userId, room.id, message.id);
  const changes = await s.history(alice.userId, room.id, message.seq, beforeDelete);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ id: message.id, seq: message.seq });
  expect(changes[0].deleted_at).toBeTruthy();
});
test('shared history pages the newest 200 messages and returns older messages before the first visible sequence', async () => {
  const rows = Array.from({ length: 205 }, () => '(gen_random_uuid(),$1,$2,\'message\',$3::jsonb,1)').join(',');
  await fixture.query(`INSERT INTO shared_messages(id,conversation_id,sender_user_id,kind,payload,key_version) VALUES ${rows}`,
    [room.id, alice.userId, JSON.stringify({ text: 'history' })]);
  const recent = await s.history(alice.userId, room.id, 0, null, '9223372036854775807', 200);
  expect(recent).toHaveLength(200);
  expect(Number(recent[0].seq)).toBe(6);
  expect(Number(recent.at(-1).seq)).toBe(205);
  const older = await s.history(alice.userId, room.id, 0, null, String(recent[0].seq), 200);
  expect(older.map(row => Number(row.seq))).toEqual([1, 2, 3, 4, 5]);
});
postgresHistoryTest('account invitations bind to verified email and concurrent acceptance joins the exact existing room', async () => {
  await expect(invitations.createAccountInvitation(bob.userId,room.id,bob.email,uid())).rejects.toMatchObject({ status:404 });
  await expect(invitations.listConversationInvitations(bob.userId,room.id)).rejects.toMatchObject({ status:403 });
  const first = await invitations.createAccountInvitation(alice.userId, room.id, '  BOB@EXAMPLE.TEST ', uid());
  const repeated = await invitations.createAccountInvitation(alice.userId, room.id, bob.email, uid());
  expect(repeated.invitationId).toBe(first.invitationId);
  expect(first).toMatchObject({ conversationId: room.id, recipientEmail: bob.email, state: 'pending', deliveryState: 'in_app_only' });
  expect(await invitations.listIncomingInvitations(bob.userId)).toEqual([expect.objectContaining({ invitationId:first.invitationId, conversationId:room.id })]);
  expect(await invitations.getInvitationPreview(bob.userId, first.invitationId)).toMatchObject({
    invitationId: first.invitationId, agentName: expect.any(String), recipientEmail: bob.email, verified: true, available: true
  });
  await expect(invitations.getInvitationPreview(eve.userId, first.invitationId)).rejects.toMatchObject({ status:404 });
  const accepted = await Promise.all([
    invitations.acceptAccountInvitation(bob.userId, first.invitationId, uid()),
    invitations.acceptAccountInvitation(bob.userId, first.invitationId, uid())
  ]);
  expect(accepted.every(row => row.conversationId===room.id)).toBe(true);
  expect((await threads.getChatContext(bob.userId,room.id)).capabilities).toMatchObject({ read:false,send:false });
  expect(await invitations.listConversationInvitations(alice.userId,room.id)).toEqual([expect.objectContaining({ invitationId:first.invitationId,state:'accepted' })]);
  await expect(invitations.revokeInvitation(alice.userId,first.invitationId)).rejects.toMatchObject({ status:404 });
});
postgresHistoryTest('unverified invited email cannot accept; revoke stops pending account admission', async () => {
  const invite = await invitations.createAccountInvitation(alice.userId,room.id,eve.email,uid());
  await fixture.query('UPDATE users SET email_verified=FALSE WHERE user_id=$1',[eve.userId]);
  await expect(invitations.acceptAccountInvitation(eve.userId,invite.invitationId,uid())).rejects.toMatchObject({ status:403 });
  await expect(s.accept(eve.userId, room.id)).rejects.toMatchObject({ status:404 });
  expect((await fixture.query('SELECT status FROM shared_members WHERE conversation_id=$1 AND user_id=$2', [room.id, eve.userId])).rows).toHaveLength(0);
  await expect(invitations.revokeInvitation(alice.userId,invite.invitationId)).resolves.toMatchObject({ state:'revoked' });
  await expect(invitations.getInvitationPreview(eve.userId,invite.invitationId)).resolves.toMatchObject({ state:'revoked',available:false });
  await expect(invitations.acceptAccountInvitation(eve.userId,invite.invitationId,uid())).rejects.toMatchObject({ status:410 });
});
postgresHistoryTest('account invitation request replay cannot change its conversation or recipient', async () => {
  const requestId = uid();
  const invite = await invitations.createAccountInvitation(alice.userId, room.id, bob.email, requestId);
  expect(await invitations.createAccountInvitation(alice.userId, room.id, bob.email, requestId)).toMatchObject({ invitationId: invite.invitationId });
  await expect(invitations.createAccountInvitation(alice.userId, secondRoom.id, bob.email, requestId)).rejects.toMatchObject({ status:409 });
  await expect(invitations.createAccountInvitation(alice.userId, room.id, eve.email, requestId)).rejects.toMatchObject({ status:409 });
});
test('same timeline, authenticated identity, private history remains separate', async () => {
  await fixture.query("INSERT INTO user_messages(agent_id,content) VALUES($1,'PRIVATE SECRET')", [agent]);
  await join();
  const a = await s.send(alice.userId, room.id, await body('From Alice'));
  const b = await s.send(bob.userId, room.id, await body('From Bob', {
    sender_user_id: alice.userId
  }));
  expect(b.sender_user_id).toBe(bob.userId);
  const h = await s.history(bob.userId, room.id, 0);
  expect(h.map(m => m.id)).toEqual([a.id, b.id]);
  expect(JSON.stringify(h)).not.toContain('PRIVATE SECRET');
  expect((await request(app).get(`/shared/${room.id}/messages`).set('x-test-user', eve.userId)).status).toBe(404);
});
test('late join gets retained history keys, removal blocks access and requires fresh keys', async () => {
  await s.send(alice.userId, room.id, await body('Before Bob'));
  await join();
  const d = await s.get(bob.userId, room.id);
  expect(d.keys.length).toBe(1);
  await s.membership(alice.userId, room.id, bob.userId, {});
  await expect(s.history(bob.userId, room.id, 0)).rejects.toMatchObject({
    status: 404
  });
  await expect(s.send(alice.userId, room.id, await body('blocked'))).rejects.toMatchObject({
    status: 409
  });
  await provision(true);
  await expect(s.send(alice.userId, room.id, await body('stale'))).rejects.toMatchObject({
    status: 409
  });
  expect((await fixture.query('SELECT * FROM shared_key_envelopes WHERE principal=$1', ['user:' + bob.userId])).rows).toHaveLength(0);
});
test('key recovery pauses access until another manager approves and reprovisions history', async () => {
  await join();
  await s.send(alice.userId, room.id, await body('Before recovery'));
  const recovered = await C.identity(account, 'fixture-recovered');
  await s.recoverIdentity(bob.userId, {
    ...recovered,
    confirm: true
  });
  const paused = await s.get(alice.userId, room.id);
  expect(paused.room.rotation_required).toBe(true);
  expect(paused.members.find(m => m.user_id === bob.userId).status).toBe('recovering');
  expect(paused.keys).toEqual(expect.any(Array));
  expect((await fixture.query('SELECT * FROM shared_key_envelopes WHERE conversation_id=$1 AND principal=$2', [room.id, 'user:' + bob.userId])).rows).toHaveLength(0);
  await expect(s.get(bob.userId, room.id)).rejects.toMatchObject({
    status: 404
  });
  await s.approveRecovery(alice.userId, room.id, bob.userId);
  const pending = await s.get(alice.userId, room.id);
  expect(pending.members.find(m => m.user_id === bob.userId).status).toBe('pending');
  await provision();
  const active = await s.get(bob.userId, room.id);
  expect(active.room.rotation_required).toBe(false);
  expect(active.room.member.status).toBe('active');
  expect(active.keys.map(k => k.key_version).sort()).toEqual([1, 2]);
});
test('owner can adopt a stopped runtime without discarding uncertain work or permissions', async () => {
  await join();
  await s.send(alice.userId, room.id, await body('Needs recovery'));
  const batch = await s.claim(agent, runtimeId);
  const newRuntimeId = uid();
  const forbidden = await request(app).post(`/shared/${room.id}/runtime/adopt`).set('x-test-user', bob.userId).send({
    confirmedStopped: true,
    newRuntimeId
  });
  expect(forbidden.status).toBe(403);
  const unconfirmed = await request(app).post(`/shared/${room.id}/runtime/adopt`).send({
    newRuntimeId
  });
  expect(unconfirmed.status).toBe(400);
  const before = (await fixture.query('SELECT capabilities,execution_id,execution_kind,execution_uncertain FROM shared_runtimes WHERE agent_id=$1', [agent])).rows[0];
  const beforeAgent = (await fixture.query('SELECT runtime_config,allowed_permissions FROM agents WHERE agent_id=$1', [agent])).rows[0];
  const adopted = await request(app).post(`/shared/${room.id}/runtime/adopt`).send({
    confirmedStopped: true,
    newRuntimeId
  });
  expect(adopted.status).toBe(200);
  expect(adopted.body).toMatchObject({
    ok: true,
    runtimeId: newRuntimeId,
    executionId: batch.id,
    executionUncertain: true
  });
  await expect(s.agentBatch(agent, runtimeId, batch.id)).rejects.toMatchObject({
    status: 409
  });
  expect((await s.agentBatch(agent, newRuntimeId, batch.id)).status).toBe('uncertain');
  const after = (await fixture.query('SELECT runtime_id,capabilities,execution_id,execution_kind,execution_uncertain FROM shared_runtimes WHERE agent_id=$1', [agent])).rows[0];
  const afterAgent = (await fixture.query('SELECT runtime_config,allowed_permissions FROM agents WHERE agent_id=$1', [agent])).rows[0];
  expect(after.runtime_id).toBe(newRuntimeId);
  expect(after).toMatchObject({
    capabilities: before.capabilities,
    execution_id: before.execution_id,
    execution_kind: before.execution_kind,
    execution_uncertain: true
  });
  expect(afterAgent).toEqual(beforeAgent);
});
test('recovery controls stay bound to the requested room', async () => {
  await join();
  const batchId = uid();
  await fixture.query("INSERT INTO shared_batches(id,conversation_id,agent_id,status) VALUES($1,$2,$3,'uncertain')", [batchId, secondRoom.id, agent]);
  await fixture.query("UPDATE shared_runtimes SET execution_id=$2,execution_kind='shared',execution_uncertain=TRUE WHERE agent_id=$1", [agent, batchId]);
  await expect(s.control(alice.userId, room.id, {
    action: 'retry'
  })).rejects.toMatchObject({
    status: 409
  });
  const batch = (await fixture.query('SELECT status,conversation_id FROM shared_batches WHERE id=$1', [batchId])).rows[0];
  expect(batch).toMatchObject({
    status: 'uncertain',
    conversation_id: secondRoom.id
  });
  const runtime = (await fixture.query('SELECT execution_id,execution_uncertain FROM shared_runtimes WHERE agent_id=$1', [agent])).rows[0];
  expect(runtime).toMatchObject({
    execution_id: batchId,
    execution_uncertain: true
  });
});
test('shared operations require the current runtime credential epoch', async () => {
  const currentCredential = uid();
  const replacementCredential = uid();
  for (const credentialId of [currentCredential, replacementCredential]) await fixture.query(`INSERT INTO agent_api_credentials
    (credential_id,agent_id,token_hash,token_prefix,scopes_json) VALUES($1,$2,$3,'test','[]'::jsonb)`, [credentialId, agent, credentialId + '-hash']);
  await s.registerRuntime(agent, {
    runtimeId,
    protocol: 1,
    profiles: [{
      provider: 'fixture',
      model: 'test'
    }]
  }, currentCredential);
  await expect(s.agentDetails(agent, room.id, runtimeId, replacementCredential)).rejects.toMatchObject({
    status: 409
  });
  await expect(s.agentHistory(agent, room.id, 0, runtimeId, replacementCredential)).rejects.toMatchObject({
    status: 409
  });
  await expect(s.agentSend(agent, room.id, await body('forged runtime'), runtimeId, replacementCredential)).rejects.toMatchObject({
    status: 409
  });
  await expect(s.putFile('agent:' + agent, room.id, 1, uid(), Buffer.alloc(40), agent, runtimeId, replacementCredential)).rejects.toMatchObject({
    status: 409
  });
  await expect(s.getFile('agent:' + agent, room.id, uid(), agent, runtimeId, replacementCredential)).rejects.toMatchObject({
    status: 409
  });
  await expect(s.agentBatch(agent, runtimeId, uid(), replacementCredential)).rejects.toMatchObject({
    status: 409
  });
  await fixture.query('UPDATE agent_api_credentials SET revoked_at=NOW() WHERE credential_id=$1', [currentCredential]);
  await expect(s.agentDetails(agent, room.id, runtimeId, currentCredential)).rejects.toMatchObject({
    status: 409
  });
  await s.registerRuntime(agent, {
    runtimeId,
    protocol: 1,
    profiles: [{
      provider: 'fixture',
      model: 'test'
    }]
  }, replacementCredential);
  const detail = await s.agentDetails(agent, room.id, runtimeId, replacementCredential);
  expect(detail.runtime.capabilities).not.toHaveProperty('credentialId');
  const route = await request(app).get(`/agent/${room.id}`).set('x-credential-id', replacementCredential).set('x-shared-runtime', runtimeId);
  expect(route.status).toBe(200);
  const revokedRoute = await request(app).get(`/agent/${room.id}`).set('x-credential-id', currentCredential).set('x-shared-runtime', runtimeId);
  expect(revokedRoute.status).toBe(409);
});
test('claim ignores removed queued senders even if a stale room state is recoverable', async () => {
  await join();
  const message = await s.send(bob.userId, room.id, await body('Queued before removal'));
  await s.membership(alice.userId, room.id, bob.userId, {});
  await fixture.query('UPDATE shared_conversations SET rotation_required=FALSE WHERE id=$1', [room.id]);
  expect(await s.claim(agent, runtimeId)).toBeNull();
  const saved = (await fixture.query('SELECT batch_id FROM shared_messages WHERE id=$1', [message.id])).rows[0];
  expect(saved.batch_id).toBeNull();
});
test('retry leaves revoked messages in their old batch and restores active messages only', async () => {
  await join();
  const ownerMessage = await s.send(alice.userId, room.id, await body('Owner work'));
  const memberMessage = await s.send(bob.userId, room.id, await body('Member work'));
  const batch = await s.claim(agent, runtimeId);
  await s.release(agent, runtimeId, batch.id, true);
  await s.membership(alice.userId, room.id, bob.userId, {});
  await s.control(alice.userId, room.id, {
    action: 'retry'
  });
  const rows = (await fixture.query('SELECT id,batch_id FROM shared_messages WHERE id IN ($1,$2) ORDER BY seq', [ownerMessage.id, memberMessage.id])).rows;
  expect(rows).toEqual([
    expect.objectContaining({
      id: ownerMessage.id,
      batch_id: null
    }),
    expect.objectContaining({
      id: memberMessage.id,
      batch_id: batch.id
    })
  ]);
  await fixture.query('UPDATE shared_conversations SET rotation_required=FALSE WHERE id=$1', [room.id]);
  const retried = await s.claim(agent, runtimeId);
  expect(retried.messages.map(m => m.id)).toEqual([ownerMessage.id]);
  expect((await s.history(alice.userId, room.id, 0)).map(m => m.id)).toEqual([ownerMessage.id, memberMessage.id]);
});
test('orphan uploads can be rekeyed while linked files remain immutable', async () => {
  await join();
  const orphanId = uid();
  const linkedId = uid();
  const originalOrphan = Buffer.alloc(40, 1);
  const originalLinked = Buffer.alloc(40, 2);
  await s.putFile(`user:${alice.userId}`, room.id, 1, orphanId, originalOrphan);
  await s.putFile(`user:${alice.userId}`, room.id, 1, linkedId, originalLinked);
  await s.send(alice.userId, room.id, await body('Linked attachment', {
    fileIds: [linkedId]
  }));
  await s.membership(alice.userId, room.id, bob.userId, {});
  const rotated = await provision(true);
  const replacementOrphan = Buffer.alloc(40, 3);
  const replacementLinked = Buffer.alloc(40, 4);
  await s.putFile(`user:${alice.userId}`, room.id, 2, orphanId, replacementOrphan);
  await s.putFile(`user:${alice.userId}`, room.id, 2, linkedId, replacementLinked);
  const rows = (await fixture.query('SELECT id,key_version,message_id,bytes FROM shared_files WHERE id IN ($1,$2) ORDER BY id', [orphanId, linkedId])).rows;
  const orphan = rows.find(row => row.id === orphanId);
  const linked = rows.find(row => row.id === linkedId);
  expect(orphan).toMatchObject({
    key_version: 2,
    message_id: null
  });
  expect(Buffer.from(orphan.bytes)).toEqual(replacementOrphan);
  expect(linked.key_version).toBe(1);
  expect(linked.message_id).toBeTruthy();
  expect(Buffer.from(linked.bytes)).toEqual(originalLinked);
  expect(rotated.get(2)).toBeTruthy();
});
test('concurrent removal and send serialize on the conversation lock', async () => {
  await join();
  const candidate = body('Racing send');
  const [removed, sent] = await Promise.allSettled([s.membership(alice.userId, room.id, bob.userId, {}), candidate.then(message => s.send(bob.userId, room.id, message))]);
  expect(removed.status).toBe('fulfilled');
  const roomState = (await fixture.query('SELECT rotation_required FROM shared_conversations WHERE id=$1', [room.id])).rows[0];
  expect(roomState.rotation_required).toBe(true);
  if (sent.status === 'fulfilled') {
    expect(sent.value.sender_user_id).toBe(bob.userId);
    expect(sent.value.created_at).toBeTruthy();
  } else {
    expect(sent.reason).toMatchObject({
      status: expect.any(Number)
    });
    expect([404, 409]).toContain(sent.reason.status);
  }
  await expect(s.history(bob.userId, room.id, 0)).rejects.toMatchObject({
    status: 404
  });
  await expect(Promise.all([s.membership(alice.userId, room.id, bob.userId, {})])).rejects.toMatchObject({
    status: 403
  });
});
test('default manager can change configured profiles and stop but cannot widen permissions', async () => {
  await join();
  await s.control(bob.userId, room.id, {
    action: 'profile',
    provider: 'fixture',
    model: 'other',
    allowed_permissions: {
      widen: true
    }
  });
  const a = (await fixture.query('SELECT * FROM agents WHERE agent_id=$1', [agent])).rows[0];
  expect(a.allowed_permissions).toEqual({
    keep: 'unchanged'
  });
  expect(a.runtime_config.sandbox_mode).toBe('none');
  expect(a.runtime_config.model).toBe('other');
  await expect(s.control(bob.userId, room.id, {
    action: 'profile',
    provider: 'arbitrary',
    model: 'test'
  })).rejects.toMatchObject({
    status: 400
  });
  await s.control(bob.userId, room.id, {
    action: 'stop'
  });
  expect((await fixture.query('SELECT stop_requested_at FROM agents WHERE agent_id=$1', [agent])).rows[0].stop_requested_at).toBeTruthy();
});
test('participant cannot manage or impersonate owner', async () => {
  await join('participant');
  await expect(s.control(bob.userId, room.id, {
    action: 'stop'
  })).rejects.toMatchObject({
    status: 403
  });
  await expect(s.membership(bob.userId, room.id, alice.userId, {})).rejects.toMatchObject({
    status: 403
  });
});
test('claim combines pending requests, preserves new arrivals and serializes execution', async () => {
  await join();
  const a = await s.send(alice.userId, room.id, await body('Alice'));
  const b = await s.send(bob.userId, room.id, await body('Bob'));
  const batch = await s.claim(agent, runtimeId);
  expect(batch.messages.map(m => m.id)).toEqual([a.id, b.id]);
  expect((await s.agentBatch(agent, runtimeId, batch.id)).status).toBe('processing');
  const later = await s.send(bob.userId, room.id, await body('Later'));
  await expect(s.claim(agent, runtimeId)).rejects.toMatchObject({
    status: 409
  });
  await expect(s.acquire(agent, runtimeId, 'private', uid())).rejects.toMatchObject({
    status: 409
  });
  const reply = await body('Reply to Alice', {
    addressedTo: [alice.userId],
    replyTo: [a.id]
  });
  await s.finish(agent, runtimeId, batch.id, {
    messages: [reply]
  });
  expect((await s.agentBatch(agent, runtimeId, batch.id)).status).toBe('answered');
  await s.finish(agent, runtimeId, batch.id, {
    messages: [reply]
  });
  expect((await s.history(bob.userId, room.id, 0)).filter(m => m.id === reply.id)).toHaveLength(0);
  expect((await s.history(alice.userId, room.id, 0)).filter(m => m.id === reply.id)).toHaveLength(1);
  expect((await s.claim(agent, runtimeId)).messages.map(m => m.id)).toEqual([later.id]);
});
test('named questions restrict answers and group questions resolve once', async () => {
  await join();
  await s.send(alice.userId, room.id, await body('Ask'));
  const batch = await s.claim(agent, runtimeId);
  const q = await body('Alice?', {
    kind: 'question',
    addressedTo: [alice.userId]
  });
  const group = await body('Anyone?', {
    kind: 'question'
  });
  await s.finish(agent, runtimeId, batch.id, {
    messages: [q, group]
  });
  await expect(s.answer(bob.userId, room.id, q.id, await body('No'))).rejects.toMatchObject({
    status: 404
  });
  await s.answer(alice.userId, room.id, q.id, await body('Yes'));
  await s.answer(bob.userId, room.id, group.id, await body('First'));
  expect((await s.answer(alice.userId, room.id, group.id, await body('Second'))).existing).toBe(true);
});
test('uncertain work is never automatically replayed; manager can retry explicitly', async () => {
  await join();
  const message = await s.send(alice.userId, room.id, await body('Work'));
  const batch = await s.claim(agent, runtimeId);
  await s.release(agent, runtimeId, batch.id, true);
  await expect(s.claim(agent, runtimeId)).rejects.toMatchObject({
    status: 409
  });
  await s.control(bob.userId, room.id, {
    action: 'retry'
  });
  expect((await s.claim(agent, runtimeId)).messages[0].id).toBe(message.id);
});
test('idempotent sends, file isolation and deletion tombstones', async () => {
  await join();
  const id = uid();
  await s.putFile('user:' + alice.userId, room.id, 1, id, Buffer.alloc(40, 2));
  await expect(s.getFile('user:' + bob.userId, room.id, id)).rejects.toMatchObject({
    status: 404
  });
  const b = await body('file', {
    fileIds: [id]
  });
  await s.send(alice.userId, room.id, b);
  await s.send(alice.userId, room.id, b);
  expect(await s.history(alice.userId, room.id, 0)).toHaveLength(1);
  expect((await s.getFile('user:' + bob.userId, room.id, id)).bytes.length).toBe(40);
  await s.removeMessage(bob.userId, room.id, b.id);
  const h = await s.history(alice.userId, room.id, 0);
  expect(h[0].payload).toBeNull();
  expect(h[0].deleted_at).toBeTruthy();
  await expect(s.getFile('user:' + bob.userId, room.id, id)).rejects.toMatchObject({
    status: 404
  });
});
(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip)('real PostgreSQL resolves concurrent answers and claims atomically', async () => {
  await join();
  await s.send(alice.userId, room.id, await body('Work'));
  const claims = await Promise.allSettled([s.claim(agent, runtimeId), s.claim(agent, runtimeId)]);
  expect(claims.filter(c => c.status === 'fulfilled')).toHaveLength(1);
  const batch = claims.find(c => c.status === 'fulfilled').value;
  const q = await body('Group?', {
    kind: 'question'
  });
  await s.finish(agent, runtimeId, batch.id, {
    messages: [q]
  });
  const results = await Promise.all([s.answer(alice.userId, room.id, q.id, await body('a')), s.answer(bob.userId, room.id, q.id, await body('b'))]);
  expect(results.filter(r => r.existing)).toHaveLength(1);
});
(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip)('real PostgreSQL claim waits for revocation and then excludes the sender', async () => {
  await join();
  await s.send(bob.userId, room.id, await body('Blocked queued work'));
  const client = await fixture.pool.connect();
  let claim;
  try {
    await client.query('BEGIN');
    await client.query('SELECT agent_id FROM shared_runtimes WHERE agent_id=$1 FOR UPDATE', [agent]);
    await client.query('SELECT id FROM shared_conversations WHERE id=$1 FOR UPDATE', [room.id]);
    await client.query("UPDATE shared_members SET status='removed' WHERE conversation_id=$1 AND user_id=$2", [room.id, bob.userId]);
    await client.query('UPDATE shared_conversations SET rotation_required=FALSE WHERE id=$1', [room.id]);
    claim = s.claim(agent, runtimeId);
    await new Promise(resolve => setImmediate(resolve));
    await client.query('COMMIT');
    expect(await claim).toBeNull();
  } finally {
    client.release();
  }
});
