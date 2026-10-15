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
  '051_retain_shared_task_attempts.sql',
  '053_bind_shared_action_approvals.sql'
].map(file => fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
const uid = () => crypto.randomUUID();
let fixture, service, authorization, alice, bob, agent, room, device, grant, runtimeId, messageId;

function resultBody() {
  return { messages: [{
    id: uid(), kind: 'message', keyVersion: 1,
    payload: { v: 1, iv: '1234567890123456', data: 'YWJjZGVmZ2hpamtsbW5vcA==' },
    addressedTo: [], replyTo: [], fileIds: []
  }] };
}

async function waitForLockWait(blocker) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await fixture.query(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [blocker.processID]);
    if (rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The tested authorization operation never waited for the policy lock');
}

async function setup() {
  jest.resetModules();
  if (process.env.SHARED_TEST_DATABASE_URL) {
    const { Pool } = require('pg');
    const schemaName = 'context_test_' + uid().replace(/-/g, '');
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
    const memory = newDb({
      autoCreateForeignKeyIndices: false
    });
    memory.public.registerFunction({
      name: 'gen_random_uuid',
      returns: 'uuid',
      implementation: uid,
      impure: true
    });
    memory.public.registerFunction({
      name: 'now',
      returns: 'timestamp',
      implementation: () => new Date(),
      impure: true
    });
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
  jest.doMock('../../src/db/connection', () => ({
    query: fixture.query,
    getClient: () => fixture.pool.connect()
  }));
  service = require('../../src/shared/service');
  authorization = require('../../src/shared/authorization');
  alice = await seedUser(fixture.query, {
    email: 'alice.execution@example.test'
  });
  bob = await seedUser(fixture.query, {
    email: 'bob.execution@example.test'
  });
  agent = uid();
  room = uid();
  runtimeId = uid();
  await fixture.query(`INSERT INTO agents(agent_id,user_id,agent_name,position,allowed_permissions)
    VALUES($1,$2,'Context agent',0,'{}'::jsonb)`, [agent, alice.userId]);
  await fixture.query(`INSERT INTO shared_conversations(id,agent_id,owner_id,title)
    VALUES($1,$2,$3,'Context room')`, [room, agent, alice.userId]);
  await fixture.query(`INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by)
    VALUES($1,$2,'owner','active',$2),($1,$3,'participant','active',$2)`, [room, alice.userId, bob.userId]);
  await fixture.query(`INSERT INTO shared_identities(principal,public_key,display_name)
    VALUES($1,'{}'::jsonb,'Context agent'),($2,'{}'::jsonb,'Bob')`, [`agent:${agent}`, `user:${bob.userId}`]);
  await fixture.query(`INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key)
    VALUES($1,1,$2,'wrapped'),($1,1,$3,'wrapped')`, [room, `agent:${agent}`, `user:${bob.userId}`]);
  device = await authorization.createDevice(alice.userId, {
    agentId: agent,
    deviceLabel: 'Context workstation',
    platform: 'linux',
    executorType: 'container',
    workspaceAliases: ['Website'],
    capabilities: {
      actions: ['workspace.read', 'project.test'],
      resources: ['Website'],
      destinations: ['preview']
    }
  });
  grant = await authorization.createGrant(alice.userId, {
    agentId: agent,
    roomId: room,
    deviceId: device.device_id,
    granteeKind: 'user',
    granteeId: bob.userId,
    workspaceAlias: 'Website',
    actions: ['workspace.read', 'project.test'],
    resources: ['Website'],
    destinations: ['preview']
  });
  await service.registerRuntime(agent, {
    runtimeId,
    protocol: 2,
    deviceId: device.device_id,
    profiles: [{
      provider: 'fixture',
      model: 'context'
    }]
  });
  const message = await service.send(bob.userId, room, {
    id: uid(),
    keyVersion: 1,
    payload: {
      v: 1,
      iv: '1234567890123456',
      data: 'YWJjZGVmZ2hpamtsbW5vcA=='
    },
    addressedTo: [],
    replyTo: [],
    fileIds: []
  });
  messageId = message.id;
}

beforeEach(setup);
afterEach(async () => {
  await fixture?.cleanup();
  jest.resetModules();
});

test('044 task context migration is additive and idempotent on PostgreSQL', async () => {
  if (process.env.SHARED_TEST_DATABASE_URL) await fixture.query(migrations[2]);
  const tables = (await fixture.query(`SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('shared_tasks','shared_task_actions')`)).rows;
  expect(new Set(tables.map(row => row.table_name))).toEqual(new Set(['shared_tasks', 'shared_task_actions']));
});

test('protocol 2 claim carries typed requester, executor and immutable grant context', async () => {
  const batch = await service.claim(agent, runtimeId);
  expect(batch.context).toMatchObject({
    contextVersion: 2,
    agent: {
      id: agent,
      ownerUserId: alice.userId
    },
    conversation: {
      id: room,
      visibility: 'all-members'
    },
    request: {
      taskId: batch.id,
      requester: {
        kind: 'user',
        id: bob.userId
      },
      shareId: grant.grant_id,
      messageIds: [messageId]
    },
    execution: {
      connectorId: runtimeId,
      executorId: device.device_id,
      deviceLabel: 'Context workstation',
      workspaceAlias: 'Website',
      isolation: 'project-container',
      identityStatus: 'owner-approved'
    },
    authorization: {
      grantId: grant.grant_id,
      policyRevision: 1,
      allowed: ['workspace.read', 'project.test'],
      resources: ['Website'],
      destinations: ['preview'],
      deviceEpoch: 1,
      deviceId: device.device_id
    }
  });
  const task = (await fixture.query('SELECT requester_kind,requester_id,grant_id,grant_revision,state,device_id,connector_id FROM shared_tasks WHERE task_id=$1', [batch.id])).rows[0];
  expect(task).toMatchObject({
    requester_kind: 'user',
    requester_id: bob.userId,
    grant_id: grant.grant_id,
    grant_revision: 1,
    state: 'running',
    device_id: device.device_id,
    connector_id: runtimeId
  });
});

test('publication rejects a revoked grant and retains task provenance', async () => {
  const batch = await service.claim(agent, runtimeId);
  await authorization.revokeGrant(alice.userId, grant.grant_id);
  await expect(service.finish(agent, runtimeId, batch.id, {
    messages: [{
      id: uid(),
      kind: 'message',
      keyVersion: 1,
      payload: {
        v: 1,
        iv: '1234567890123456',
        data: 'YWJjZGVmZ2hpamtsbW5vcA=='
      },
      addressedTo: [],
      replyTo: [],
      fileIds: []
    }]
  })).rejects.toMatchObject({
    status: 409
  });
  const task = (await fixture.query('SELECT requester_id,grant_id,grant_revision,state FROM shared_tasks WHERE task_id=$1', [batch.id])).rows[0];
  expect(task).toMatchObject({
    requester_id: bob.userId,
    grant_id: grant.grant_id,
    grant_revision: 1,
    state: 'cancellation_requested'
  });
});

test('protocol 2 queues work with an explicit unsupported state when no grant exists', async () => {
  await authorization.revokeGrant(alice.userId, grant.grant_id);
  const claimed = await service.claim(agent, runtimeId);
  expect(claimed).toBeNull();
  const task = (await fixture.query('SELECT requester_kind,requester_id,state,execution_context FROM shared_tasks WHERE first_message_id=$1', [messageId])).rows[0];
  expect(task).toMatchObject({
    requester_kind: 'user',
    requester_id: bob.userId,
    state: 'unsupported_runtime'
  });
  expect(task.execution_context.execution.unsupportedReason).toContain('No current execution grant');
  expect((await fixture.query('SELECT batch_id FROM shared_messages WHERE id=$1', [messageId])).rows[0].batch_id).toBeNull();
});

test.each([
  { capabilities: { actions: ['workspace.read'], resources: ['Website'], destinations: ['preview'] } },
  { capabilities: { actions: ['workspace.read', 'project.test'], resources: [], destinations: ['preview'] } },
  { capabilities: { actions: ['workspace.read', 'project.test'], resources: ['Website'], destinations: [] } },
  { workspaceAliases: ['Different workspace'] }
])('narrowed device scope blocks claims and direct grant authorization: %j', async change => {
  const updated = await authorization.updateDevice(alice.userId, device.device_id, change);
  expect(updated.credential_epoch).toBe(2);
  expect(await authorization.currentGrant({ requesterId: bob.userId, agentId: agent, roomId: room })).toBeNull();
  await expect(authorization.authorizeGrant({ requesterId: bob.userId, agentId: agent, roomId: room, action: 'project.test' })).rejects.toMatchObject({ status: 403 });
  expect(await service.claim(agent, runtimeId)).toBeNull();
  expect((await fixture.query('SELECT batch_id FROM shared_messages WHERE id=$1', [messageId])).rows[0].batch_id).toBeNull();
});

test.each([
  { executorType: 'host' },
  { runnerVersion: 'new-runner' },
  { platform: 'different-platform' },
  { capabilities: { actions: ['workspace.read'], resources: ['Website'], destinations: ['preview'] } }
])('device execution policy changes hold an already claimed result: %j', async change => {
  const batch = await service.claim(agent, runtimeId);
  await authorization.updateDevice(alice.userId, device.device_id, change);
  await expect(service.finish(agent, runtimeId, batch.id, resultBody())).rejects.toMatchObject({ status: 409, message: expect.stringContaining('held for review') });
  const retained = (await fixture.query('SELECT grant_snapshot,device_epoch,current_authorization FROM shared_tasks WHERE task_id=$1', [batch.id])).rows[0];
  expect(retained.device_epoch).toBe(1);
  expect(retained.grant_snapshot.deviceEpoch).toBe(1);
  expect(retained.current_authorization.state).toBe('authorization_changed');
  expect((await fixture.query('SELECT status FROM shared_batches WHERE id=$1', [batch.id])).rows[0].status).toBe('processing');
});

test('cosmetic and reordered device updates preserve the execution epoch', async () => {
  const updated = await authorization.updateDevice(alice.userId, device.device_id, {
    deviceLabel: 'Renamed workstation',
    capabilities: { actions: ['project.test', 'workspace.read'], destinations: ['preview'], resources: ['Website'] }
  });
  expect(updated.credential_epoch).toBe(1);
  expect((await service.claim(agent, runtimeId)).context.authorization.deviceEpoch).toBe(1);
});

test('claim fails closed when an existing device ceiling was narrowed without an epoch update', async () => {
  await fixture.query('UPDATE agent_devices SET capabilities=$2 WHERE device_id=$1', [device.device_id, JSON.stringify({ actions: ['workspace.read'], resources: ['Website'], destinations: ['preview'] })]);
  expect(await service.claim(agent, runtimeId)).toBeNull();
});

test('a replacement grant with the same revision cannot authorize an earlier task result', async () => {
  const batch = await service.claim(agent, runtimeId);
  await authorization.revokeGrant(alice.userId, grant.grant_id);
  const replacement = await authorization.createGrant(alice.userId, {
    agentId: agent, roomId: room, deviceId: device.device_id, granteeId: bob.userId,
    workspaceAlias: 'Website', actions: ['workspace.read', 'project.test'], resources: ['Website'], destinations: ['preview']
  });
  expect(replacement.revision).toBe(grant.revision);
  expect(replacement.grant_id).not.toBe(grant.grant_id);
  await expect(service.finish(agent, runtimeId, batch.id, resultBody())).rejects.toMatchObject({ status: 409 });
  expect((await fixture.query('SELECT grant_id,current_authorization FROM shared_tasks WHERE task_id=$1', [batch.id])).rows[0]).toMatchObject({
    grant_id: grant.grant_id, current_authorization: { state: 'authorization_changed' }
  });
});

(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip).each(['grant', 'device'])(
  'real PostgreSQL claim observes a concurrent %s revocation before granting execution', async target => {
    const blocker = await fixture.pool.connect();
    let claim;
    try {
      await blocker.query('BEGIN');
      if (target === 'grant') await blocker.query("UPDATE agent_share_grants SET status='revoked',revision=revision+1 WHERE grant_id=$1", [grant.grant_id]);
      else await blocker.query('UPDATE agent_devices SET revoked_at=NOW(),credential_epoch=credential_epoch+1 WHERE device_id=$1', [device.device_id]);
      claim = service.claim(agent, runtimeId);
      await waitForLockWait(blocker);
      await blocker.query('COMMIT');
      expect(await claim).toBeNull();
      expect((await fixture.query('SELECT batch_id FROM shared_messages WHERE id=$1', [messageId])).rows[0].batch_id).toBeNull();
    } finally {
      await blocker.query('ROLLBACK');
      await claim?.catch(() => {});
      blocker.release();
    }
  }
);

(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip).each(['grant', 'device'])(
  'real PostgreSQL publication waits for a concurrent %s policy change and withholds the result', async target => {
    const batch = await service.claim(agent, runtimeId);
    const reply = resultBody();
    const blocker = await fixture.pool.connect();
    let outcome;
    try {
      await blocker.query('BEGIN');
      if (target === 'grant') await blocker.query('UPDATE agent_share_grants SET revision=revision+1 WHERE grant_id=$1', [grant.grant_id]);
      else await blocker.query('UPDATE agent_devices SET credential_epoch=credential_epoch+1 WHERE device_id=$1', [device.device_id]);
      outcome = service.finish(agent, runtimeId, batch.id, reply).then(value => ({ value }), error => ({ error }));
      await waitForLockWait(blocker);
      await blocker.query('COMMIT');
      expect((await outcome).error).toMatchObject({ status: 409 });
      expect((await fixture.query('SELECT id FROM shared_messages WHERE id=$1', [reply.messages[0].id])).rows).toHaveLength(0);
    } finally {
      await blocker.query('ROLLBACK');
      await outcome;
      blocker.release();
    }
  }
);

(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip).each(['claim', 'publication'])(
  'real PostgreSQL %s rejects a grant that expires while waiting on the device lock', async operation => {
    const batch = operation === 'publication' ? await service.claim(agent, runtimeId) : null;
    const expiresAt = new Date(Date.now() + 1500);
    await fixture.query('UPDATE agent_share_grants SET expires_at=$2 WHERE grant_id=$1', [grant.grant_id, expiresAt]);
    const blocker = await fixture.pool.connect();
    let outcome;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT device_id FROM agent_devices WHERE device_id=$1 FOR UPDATE', [device.device_id]);
      outcome = (batch ? service.finish(agent, runtimeId, batch.id, resultBody()) : service.claim(agent, runtimeId))
        .then(value => ({ value }), error => ({ error }));
      await waitForLockWait(blocker);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 30)));
      await blocker.query('COMMIT');
      const result = await outcome;
      if (batch) expect(result.error).toMatchObject({ status: 409 });
      else expect(result).toEqual({ value: null });
    } finally {
      await blocker.query('ROLLBACK');
      await outcome;
      blocker.release();
    }
  }
);

test.each(['uncertain', 'stale'])('explicit protocol-2 retry after %s creates a new attempt without replacing earlier provenance or receipts', async recovery => {
  const first = await service.claim(agent, runtimeId);
  const original = (await fixture.query('SELECT * FROM shared_tasks WHERE task_id=$1', [first.id])).rows[0];
  const action = uid(), receipt = { diagnostic: true, outcome: 'unknown' };
  await fixture.query(`INSERT INTO shared_task_actions(action_id,task_id,action_digest,action_name,approval_state,external_receipt)
    VALUES($1,$2,'retained-digest','fixture.action','approved',$3)`, [action, first.id, JSON.stringify(receipt)]);
  if (recovery === 'uncertain') await service.release(agent, runtimeId, first.id, true);
  else await fixture.query("UPDATE shared_runtimes SET last_seen_at=NOW()-INTERVAL '3 minutes' WHERE agent_id=$1", [agent]);
  await service.control(alice.userId, room, { action: 'retry' });
  const second = await service.claim(agent, runtimeId);
  expect(second.id).not.toBe(first.id);
  expect(second.context.request.taskId).toBe(second.id);
  expect(second.messages.map(message => message.id)).toEqual([messageId]);
  const retained = (await fixture.query('SELECT * FROM shared_tasks WHERE task_id=$1', [first.id])).rows[0];
  expect(retained.execution_context).toEqual(original.execution_context);
  expect(retained.grant_snapshot).toEqual(original.grant_snapshot);
  expect(retained.state).toBe('outcome_uncertain');
  expect((await fixture.query('SELECT task_id,approval_state,external_receipt FROM shared_task_actions WHERE action_id=$1', [action])).rows[0]).toEqual({ task_id: first.id, approval_state: 'revoked', external_receipt: receipt });
  expect((await fixture.query('SELECT id,task_id,status FROM shared_batches WHERE id=$1', [first.id])).rows[0]).toEqual({ id: first.id, task_id: first.id, status: 'retry' });
  expect((await fixture.query('SELECT task_id FROM shared_tasks WHERE first_message_id=$1', [messageId])).rows).toHaveLength(2);
});

(process.env.SHARED_TEST_DATABASE_URL ? test : test.skip)('attempt upgrade is repeatable and permits only one active attempt per source message', async () => {
  const first = await service.claim(agent, runtimeId);
  await fixture.query(migrations[3]); await fixture.query(migrations[3]);
  const insert = () => fixture.query(`INSERT INTO shared_tasks(task_id,first_message_id,conversation_id,agent_id,requester_kind,requester_id,state)
    VALUES($1,$2,$3,$4,'user',$5,'queued')`, [uid(), messageId, room, agent, bob.userId]);
  await expect(insert()).rejects.toMatchObject({ code: '23505' });
  await service.release(agent, runtimeId, first.id, true);
  await expect(insert()).resolves.toMatchObject({ rowCount: 1 });
  await expect(insert()).rejects.toMatchObject({ code: '23505' });
  expect((await fixture.query('SELECT task_id FROM shared_tasks WHERE task_id=$1', [first.id])).rows).toEqual([{ task_id: first.id }]);
});

test('owner requests need an explicit bounded grant and an authenticated exact-action decision', async () => {
  await fixture.query('UPDATE shared_messages SET deleted_at=NOW() WHERE id=$1', [messageId]);
  await fixture.query(`INSERT INTO shared_identities(principal,public_key,display_name)
    VALUES($1,'{}'::jsonb,'Alice')`, [`user:${alice.userId}`]);
  await fixture.query(`INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key)
    VALUES($1,1,$2,'wrapped')`, [room, `user:${alice.userId}`]);
  const source = await service.send(alice.userId, room, { ...resultBody().messages[0], fileIds: [] });
  expect(await service.claim(agent, runtimeId)).toBeNull();
  const ownerScope = { agentId: agent, roomId: room, deviceId: device.device_id, granteeId: alice.userId,
    workspaceAlias: 'Website', actions: ['project.test'], resources: ['Website'], destinations: ['preview'],
    budget: { maxRuntimeMs: 900000 }, approvalPolicy: { requiresApproval: ['project.test'] } };
  await expect(authorization.createGrant(alice.userId, { ...ownerScope, actions: ['workspace.write'] })).rejects.toMatchObject({ status: 403 });
  const ownerGrant = await authorization.createGrant(alice.userId, ownerScope);
  const batch = await service.claim(agent, runtimeId);
  expect(batch.context.request.requester).toMatchObject({ kind: 'user', id: alice.userId });
  expect(batch.context.authorization.grantId).toBe(ownerGrant.grant_id);
  expect(batch.messages.map(message => message.id)).toEqual([source.id]);
  const tasks = require('../../src/shared/taskAuthority');
  const runtime = { agentId: agent, runtimeId };
  const action = await tasks.propose(runtime, batch.id, { actionId: uid(), name: 'project.test', resource: 'Website', destination: 'preview', parameters: { command: ['node', 'test.js'] } });
  await expect(tasks.start(runtime, batch.id, action.actionId, { digest: action.digest, approved: true })).rejects.toMatchObject({ status: 403 });
  await expect(tasks.decide(bob.userId, batch.id, action.actionId, { digest: action.digest, decision: 'approve' })).rejects.toMatchObject({ status: 403 });
  await tasks.decide(alice.userId, batch.id, action.actionId, { digest: action.digest, decision: 'approve' });
  expect(await tasks.start(runtime, batch.id, action.actionId, { digest: action.digest })).toMatchObject({ outcome: 'running' });
});

async function approvalTask(requiresApproval = true) {
  await authorization.updateGrant(alice.userId, grant.grant_id, {
    budget: { maxRuntimeMs: 900000 }, approvalPolicy: { requiresApproval: requiresApproval ? ['project.test'] : [] }
  });
  const batch = await service.claim(agent, runtimeId);
  const tasks = require('../../src/shared/taskAuthority');
  const runtime = { agentId: agent, runtimeId };
  const action = await tasks.propose(runtime, batch.id, {
    actionId: uid(), name: 'project.test', resource: 'Website', destination: 'preview', parameters: { command: ['node', 'test.js'] }
  });
  return { tasks, batch, runtime, action };
}
async function serverBroker() {
  await authorization.updateGrant(alice.userId, grant.grant_id, {
    budget: { maxRuntimeMs: 900000 }, approvalPolicy: { requiresApproval: ['project.test'] }
  });
  const batch = await service.claim(agent, runtimeId), tasks = require('../../src/shared/taskAuthority');
  const runtime = { agentId: agent, runtimeId }, record = {};
  const api = async (route, body) => {
    let result;
    if (route.endsWith('/actions')) result = await tasks.propose(runtime, batch.id, body);
    else if (route.endsWith('/start')) result = await tasks.start(runtime, batch.id, record.actionId, body);
    else if (route.endsWith('/complete')) result = await tasks.complete(runtime, batch.id, record.actionId, body);
    else throw Error('Unexpected broker API operation');
    // Match Express's actual JSON boundary, including PostgreSQL Date values.
    return JSON.parse(JSON.stringify(result));
  };
  const { BoundActionBroker } = require('../../src/shared/boundActionBroker');
  // This callback is deliberately a fixture, not evidence of OS confinement.
  const execute = jest.fn(async () => 'fixture output');
  const broker = new BoundActionBroker({ context: batch.context, record, persist: jest.fn(), api, confirmedStopped: () => true });
  const descriptor = { name: 'project.test', resource: 'Website', destination: 'preview', parameters: { argv: ['node', 'fixture.js'] } };
  return { batch, tasks, runtime, broker, record, execute, descriptor };
}
test('the broker waits for a real server owner decision, consumes once and retains the matching receipt', async () => {
  const { batch, tasks, broker, record, execute, descriptor } = await serverBroker();
  broker.wait = async () => {
    expect(execute).not.toHaveBeenCalled();
    await expect(tasks.decide(bob.userId, batch.id, record.actionId, { decision: 'approve', digest: record.digest })).rejects.toMatchObject({ status: 403 });
    await tasks.decide(alice.userId, batch.id, record.actionId, { decision: 'approve', digest: record.digest });
  };
  expect(await broker.run(descriptor, execute)).toBe('fixture output');
  expect(execute).toHaveBeenCalledTimes(1);
  const saved = (await fixture.query('SELECT action_digest,execution_nonce,outcome,external_receipt FROM shared_task_actions WHERE action_id=$1', [record.actionId])).rows[0];
  expect(saved).toMatchObject({ action_digest: record.digest, execution_nonce: record.executionNonce, outcome: 'succeeded', external_receipt: record.completion.receipt });
  await expect(broker.run(descriptor, execute)).rejects.toThrow('cannot be replayed');
});
test('grant revocation during the broker approval wait prevents the execution callback', async () => {
  const { broker, execute, descriptor } = await serverBroker();
  broker.wait = async () => authorization.revokeGrant(alice.userId, grant.grant_id);
  await expect(broker.run(descriptor, execute)).rejects.toMatchObject({ status: 403 });
  expect(execute).not.toHaveBeenCalled();
});
test('server authorization supplies an absolute deadline and denies already spent approval time', async () => {
  const { tasks, batch, runtime } = await serverBroker();
  const initial = await tasks.authorize(runtime, batch.id);
  expect(initial.authorized).toBe(true); expect(Date.parse(initial.deadlineAt)).toBeGreaterThan(Date.now());
  await fixture.query('UPDATE shared_tasks SET claimed_at=$2 WHERE task_id=$1', [batch.id, new Date(Date.now() - 901000)]);
  expect(await tasks.authorize(runtime, batch.id)).toMatchObject({ authorized: false, deadlineAt: null, state: 'cancellation_requested' });
});

test('bound approvals require the authenticated owner and the exact action digest', async () => {
  const { tasks, batch, action } = await approvalTask();
  expect(action.approvalState).toBe('pending');
  await expect(tasks.decide(bob.userId, batch.id, action.actionId, { decision: 'approve', digest: action.digest, approverId: alice.userId }))
    .rejects.toMatchObject({ status: 403 });
  await expect(tasks.decide(alice.userId, batch.id, action.actionId, { decision: 'approve', digest: 'changed' }))
    .rejects.toMatchObject({ status: 409 });
  const approved = await tasks.decide(alice.userId, batch.id, action.actionId, { decision: 'approve', digest: action.digest });
  expect(approved).toMatchObject({ approvedBy: alice.userId, approvalState: 'approved' });
  await expect(tasks.decide(alice.userId, batch.id, action.actionId, { decision: 'approve', digest: action.digest }))
    .rejects.toMatchObject({ status: 409 });
});

test('one operation cannot change its command and an approved action cannot execute twice', async () => {
  const { tasks, batch, runtime, action } = await approvalTask();
  await expect(tasks.propose(runtime, batch.id, { actionId: action.actionId, name: 'project.test', resource: 'Website', destination: 'preview',
    parameters: { command: ['node', 'other.js'] } })).rejects.toMatchObject({ status: 409 });
  await expect(tasks.start(runtime, batch.id, action.actionId, { digest: action.digest, approved: true })).rejects.toMatchObject({ status: 403 });
  await tasks.decide(alice.userId, batch.id, action.actionId, { decision: 'approve', digest: action.digest });
  const started = await tasks.start(runtime, batch.id, action.actionId, { digest: action.digest });
  expect(started.outcome).toBe('running');
  await expect(tasks.start(runtime, batch.id, action.actionId, { digest: action.digest })).rejects.toMatchObject({ status: 409 });
  const result = { executionNonce: started.executionNonce, outcome: 'succeeded', receipt: { exitCode: 0 } };
  await expect(tasks.complete(runtime, batch.id, action.actionId, result)).resolves.toMatchObject({ outcome: 'succeeded' });
  await expect(tasks.complete(runtime, batch.id, action.actionId, result)).resolves.toMatchObject({ outcome: 'succeeded' });
  await expect(tasks.complete(runtime, batch.id, action.actionId, { ...result, receipt: { exitCode: 1 } })).rejects.toMatchObject({ status: 409 });
});

test.each(['grant', 'device', 'membership', 'audience', 'expiry', 'replacement'])('changed %s authority fences an already approved action', async change => {
  const { tasks, batch, runtime, action } = await approvalTask();
  await tasks.decide(alice.userId, batch.id, action.actionId, { decision: 'approve', digest: action.digest });
  if (change === 'grant') await authorization.updateGrant(alice.userId, grant.grant_id, { resources: [] });
  if (change === 'device') await authorization.updateDevice(alice.userId, device.device_id, { rotateCredential: true });
  if (change === 'membership') await fixture.query("UPDATE shared_members SET status='removed' WHERE conversation_id=$1 AND user_id=$2", [room, bob.userId]);
  if (change === 'audience') await fixture.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1', [room]);
  if (change === 'expiry') await fixture.query("UPDATE agent_share_grants SET expires_at=NOW()-INTERVAL '1 second' WHERE grant_id=$1", [grant.grant_id]);
  if (change === 'replacement') {
    await authorization.revokeGrant(alice.userId, grant.grant_id);
    const replacement = await authorization.createGrant(alice.userId, { agentId: agent, roomId: room, deviceId: device.device_id, granteeId: bob.userId,
      workspaceAlias: 'Website', actions: ['project.test'], resources: ['Website'], destinations: ['preview'], budget: { maxRuntimeMs: 900000 } });
    await fixture.query('UPDATE agent_share_grants SET revision=2 WHERE grant_id=$1', [replacement.grant_id]);
  }
  await expect(tasks.start(runtime, batch.id, action.actionId, { digest: action.digest })).rejects.toMatchObject({ status: 403 });
  expect(await tasks.authorize(runtime, batch.id)).toMatchObject({ authorized: false, state: 'cancellation_requested' });
  expect((await fixture.query('SELECT approval_state,consumed_at FROM shared_task_actions WHERE action_id=$1', [action.actionId])).rows[0])
    .toMatchObject({ approval_state: 'revoked', consumed_at: null });
});

test('owner denial and expired approval never start protected work', async () => {
  const { tasks, batch, runtime, action } = await approvalTask();
  await tasks.decide(alice.userId, batch.id, action.actionId, { decision: 'deny', digest: action.digest });
  await expect(tasks.start(runtime, batch.id, action.actionId, { digest: action.digest })).rejects.toMatchObject({ status: 403 });
  const second = await tasks.propose(runtime, batch.id, { actionId: uid(), name: 'project.test', resource: 'Website', parameters: {} });
  await fixture.query("UPDATE shared_task_actions SET expires_at=NOW()-INTERVAL '1 second' WHERE action_id=$1", [second.actionId]);
  await expect(tasks.decide(alice.userId, batch.id, second.actionId, { decision: 'approve', digest: second.digest })).rejects.toMatchObject({ status: 409 });
});

test('cancelled execution stays requested until exact stoppage and a running action receipt are confirmed', async () => {
  const { tasks, batch, runtime, action } = await approvalTask(false);
  const running = await tasks.start(runtime, batch.id, action.actionId, { digest: action.digest });
  await expect(tasks.cancel(uid(), batch.id)).rejects.toMatchObject({ status: 403 });
  expect(await tasks.cancel(bob.userId, batch.id)).toMatchObject({ state: 'cancellation_requested' });
  await expect(tasks.confirmCancellation(runtime, batch.id, { confirmedStopped: false })).rejects.toMatchObject({ status: 409 });
  await expect(tasks.confirmCancellation(runtime, batch.id, { confirmedStopped: true })).rejects.toMatchObject({ status: 409 });
  await tasks.complete(runtime, batch.id, action.actionId, { executionNonce: running.executionNonce, outcome: 'failed', receipt: { confirmedStopped: true } });
  expect(await tasks.confirmCancellation(runtime, batch.id, { confirmedStopped: true })).toMatchObject({ state: 'cancellation_confirmed' });
  expect((await fixture.query('SELECT status FROM shared_batches WHERE id=$1', [batch.id])).rows[0].status).toBe('skipped');
  expect((await fixture.query('SELECT execution_id FROM shared_runtimes WHERE agent_id=$1', [agent])).rows[0].execution_id).toBeNull();
});

test('changed-audience output is retained encrypted for only the owner, with no new shared messages', async () => {
  const { tasks, batch } = await approvalTask(false);
  await fixture.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1', [room]);
  const body = resultBody();
  await expect(service.finish(agent, runtimeId, batch.id, body)).rejects.toMatchObject({ status: 409 });
  const held = await tasks.heldResult(alice.userId, batch.id);
  expect(held.held_result.messages[0].payload).toEqual(body.messages[0].payload);
  expect(held.result_held_at).toBeTruthy();
  await expect(tasks.heldResult(bob.userId, batch.id)).rejects.toMatchObject({ status: 404 });
  expect(Number((await fixture.query('SELECT COUNT(*) AS total FROM shared_messages WHERE sender_agent_id=$1', [agent])).rows[0].total)).toBe(0);
});

test('a recently served requester yields to a waiting collaborator even when its next message is older', async () => {
  const first = await service.claim(agent, runtimeId);
  await service.finish(agent, runtimeId, first.id, resultBody());
  const carol = await seedUser(fixture.query, { email: 'carol.fairness@example.test' });
  await fixture.query("INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by) VALUES($1,$2,'participant','active',$3)", [room, carol.userId, alice.userId]);
  await fixture.query("INSERT INTO shared_identities(principal,public_key,display_name) VALUES($1,'{}','Carol')", [`user:${carol.userId}`]);
  await fixture.query("INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key) VALUES($1,1,$2,'wrapped')", [room, `user:${carol.userId}`]);
  await authorization.createGrant(alice.userId, { agentId: agent, roomId: room, deviceId: device.device_id,
    granteeId: carol.userId, workspaceAlias: 'Website', actions: ['workspace.read'], resources: ['Website'], destinations: [] });
  const payload = resultBody().messages[0].payload;
  await service.send(bob.userId, room, { id: uid(), keyVersion: 1, payload });
  const later = await service.send(carol.userId, room, { id: uid(), keyVersion: 1, payload });
  const next = await service.claim(agent, runtimeId);
  expect(next.context.request.requester.id).toBe(carol.userId);
  expect(next.messages.map(message => message.id)).toEqual([later.id]);
});
