const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const {
  createTestDatabase,
  seedUser
} = require('../utils/pgMemTestUtils');

const sharedMigration = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/042_add_shared_conversations.sql'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/043_add_agent_devices_and_share_grants.sql'), 'utf8');
const uid = () => crypto.randomUUID();
let fixture, authorization, shared, app, alice, bob, eve, agent, otherAgent, room;

async function setup() {
  jest.resetModules();
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  if (process.env.SHARED_TEST_DATABASE_URL) {
    const {
      Pool
    } = require('pg');
    const schema = 'grant_test_' + uid().replace(/-/g, '');
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
    const memory = createTestDatabase();
    fixture = {
      pool: memory.pool,
      query: memory.query,
      cleanup: () => memory.pool.end()
    };
  }
  await fixture.query(sharedMigration);
  await fixture.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/064_add_sharing_switch.sql'), 'utf8'));
  await fixture.query(migration);
  jest.doMock('../../src/db/connection', () => ({
    query: fixture.query,
    getClient: () => fixture.pool.connect()
  }));
  authorization = require('../../src/shared/authorization');
  shared = require('../../src/shared/service');
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
  otherAgent = uid();
  room = uid();
  await fixture.query(`INSERT INTO agents(agent_id,user_id,agent_name,position,allowed_permissions)
    VALUES($1,$2,'Alice agent',0,'{}'::jsonb),($3,$4,'Bob agent',0,'{}'::jsonb)`, [agent, alice.userId, otherAgent, bob.userId]);
  await fixture.query(`INSERT INTO shared_conversations(id,agent_id,owner_id,title)
    VALUES($1,$2,$3,'Website')`, [room, agent, alice.userId]);
  await fixture.query(`INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by)
    VALUES($1,$2,'owner','active',$2)`, [room, alice.userId]);
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      userId: req.headers['x-test-user'] || alice.userId
    };
    next();
  });
  app.use('/shared', require('../../src/shared/routes').users);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({
    error: {
      message: error.message
    }
  }));
}

beforeEach(setup);
afterEach(async () => {
  await fixture?.cleanup();
  delete process.env.FEATURE_SHARED_CONVERSATIONS;
  jest.resetModules();
});

test('043 migration is additive and idempotent', async () => {
  if (process.env.SHARED_TEST_DATABASE_URL) await fixture.query(migration);
  const tables = (await fixture.query(`SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('agent_devices','agent_share_grants','shared_security_events') ORDER BY table_name`)).rows;
  expect([...new Set(tables.map(row => row.table_name))]).toEqual(['agent_devices', 'agent_share_grants', 'shared_security_events']);
  const privateAgent = (await fixture.query('SELECT allowed_permissions FROM agents WHERE agent_id=$1', [agent])).rows[0];
  expect(privateAgent.allowed_permissions).toEqual({});
});

test('owner can create a device and a grant only within its explicit ceilings', async () => {
  const device = await authorization.createDevice(alice.userId, {
    agentId: agent,
    deviceLabel: 'Alice workstation',
    platform: 'linux',
    executorType: 'container',
    workspaceAliases: ['Website'],
    capabilities: {
      actions: ['workspace.read', 'workspace.write', 'project.test'],
      resources: ['Website'],
      destinations: ['preview']
    }
  });
  expect(device).toMatchObject({
    agent_id: agent,
    owner_id: alice.userId,
    verification_status: 'owner-approved',
    credential_epoch: 1
  });
  const grant = await authorization.createGrant(alice.userId, {
    agentId: agent,
    roomId: room,
    deviceId: device.device_id,
    granteeKind: 'user',
    granteeId: bob.userId,
    workspaceAlias: 'Website',
    actions: ['workspace.read', 'project.test'],
    resources: ['Website'],
    destinations: ['preview'],
    budget: {
      maxRequests: 10
    }
  });
  expect(grant.grantee).toEqual({
    kind: 'user',
    id: bob.userId
  });
  expect((await authorization.authorizeGrant({
    requesterKind: 'user',
    requesterId: bob.userId,
    agentId: agent,
    roomId: room,
    action: 'project.test',
    resource: 'Website',
    destination: 'preview'
  })).grant_id).toBe(grant.grant_id);
  await expect(authorization.authorizeGrant({
    requesterKind: 'user',
    requesterId: bob.userId,
    agentId: agent,
    roomId: room,
    action: 'workspace.write'
  })).rejects.toMatchObject({
    status: 403
  });
  await expect(authorization.createGrant(alice.userId, {
    agentId: agent,
    roomId: room,
    deviceId: device.device_id,
    granteeId: eve.userId,
    workspaceAlias: 'Website',
    actions: ['workspace.write'],
    resources: ['Website'],
    destinations: ['production']
  })).rejects.toMatchObject({
    status: 403
  });
});

test('owner checks prevent cross-agent and cross-account grants', async () => {
  const device = await authorization.createDevice(alice.userId, {
    agentId: agent,
    deviceLabel: 'Alice workstation',
    platform: 'linux',
    executorType: 'container',
    workspaceAliases: ['Website'],
    capabilities: {
      actions: ['workspace.read'],
      resources: ['Website'],
      destinations: []
    }
  });
  await expect(authorization.createDevice(bob.userId, {
    agentId: agent,
    deviceLabel: 'Wrong owner',
    platform: 'linux',
    executorType: 'container',
    workspaceAliases: ['Website'],
    capabilities: {
      actions: ['workspace.read']
    }
  })).rejects.toMatchObject({
    status: 403
  });
  await expect(authorization.createGrant(alice.userId, {
    agentId: otherAgent,
    roomId: room,
    deviceId: device.device_id,
    granteeId: eve.userId,
    workspaceAlias: 'Website',
    actions: ['workspace.read']
  })).rejects.toMatchObject({
    status: 403
  });
});

test('grant revision, expiry and device revocation invalidate authorization', async () => {
  const device = await authorization.createDevice(alice.userId, {
    agentId: agent,
    deviceLabel: 'Alice workstation',
    platform: 'linux',
    executorType: 'container',
    workspaceAliases: ['Website'],
    capabilities: {
      actions: ['workspace.read'],
      resources: ['Website'],
      destinations: []
    }
  });
  const grant = await authorization.createGrant(alice.userId, {
    agentId: agent,
    roomId: room,
    deviceId: device.device_id,
    granteeId: bob.userId,
    workspaceAlias: 'Website',
    actions: ['workspace.read'],
    resources: ['Website']
  });
  const updated = await authorization.updateGrant(alice.userId, grant.grant_id, {
    actions: ['workspace.read'],
    resources: ['Website'],
    workspaceAlias: 'Website',
    budget: {
      maxRequests: 2
    }
  });
  expect(updated.revision).toBe(2);
  expect(await authorization.currentGrant({
    requesterKind: 'user',
    requesterId: bob.userId,
    agentId: agent,
    roomId: room,
    revision: 1
  })).toBeNull();
  await fixture.query('UPDATE agent_share_grants SET expires_at=NOW()-INTERVAL \'1 minute\' WHERE grant_id=$1', [grant.grant_id]);
  expect(await authorization.currentGrant({
    requesterKind: 'user',
    requesterId: bob.userId,
    agentId: agent,
    roomId: room,
    revision: 2
  })).toBeNull();
  await authorization.revokeDevice(alice.userId, device.device_id);
  const row = (await fixture.query('SELECT verification_status,credential_epoch FROM agent_devices WHERE device_id=$1', [device.device_id])).rows[0];
  expect(row).toMatchObject({
    verification_status: 'revoked',
    credential_epoch: 2
  });
});

test('owner endpoints reject non-owners and expose no stored secrets', async () => {
  const response = await request(app).post('/shared/devices').set('x-test-user', bob.userId).send({
    agentId: agent,
    deviceLabel: 'Nope',
    platform: 'linux',
    executorType: 'container',
    workspaceAliases: ['Website'],
    capabilities: {
      actions: ['workspace.read']
    }
  });
  expect(response.status).toBe(403);
  const created = await request(app).post('/shared/devices').send({
    agentId: agent,
    deviceLabel: 'Owner device',
    platform: 'linux',
    executorType: 'container',
    workspaceAliases: ['Website'],
    capabilities: {
      actions: ['workspace.read'],
      resources: ['Website']
    }
  });
  expect(created.status).toBe(200);
  expect(created.body).not.toHaveProperty('token');
});

test.each(['denied', 'requiresApproval'])('direct authorization cannot bypass the %s action policy with a caller-issued approval', async policy => {
  const device = await authorization.createDevice(alice.userId, {
    agentId: agent, deviceLabel: 'Owner device', platform: 'linux', executorType: 'container',
    workspaceAliases: ['Website'], capabilities: { actions: ['project.publish'], resources: ['Website'], destinations: ['preview'] }
  });
  await authorization.createGrant(alice.userId, {
    agentId: agent, roomId: room, deviceId: device.device_id, granteeId: bob.userId,
    workspaceAlias: 'Website', actions: ['project.publish'], resources: ['Website'], destinations: ['preview'],
    approvalPolicy: { [policy]: ['project.publish'] }
  });
  await expect(authorization.authorizeGrant({
    requesterId: bob.userId, agentId: agent, roomId: room, action: 'project.publish',
    resource: 'Website', destination: 'preview', approved: true, approverId: alice.userId
  })).rejects.toMatchObject({ status: 403 });
});

test('new account invitations default to collaborator while explicit manager remains available', async () => {
  const owner = await shared.invite(alice.userId, room, {
    email: bob.email
  });
  expect(owner.invited).toBe(true);
  const defaultRole = (await fixture.query('SELECT role FROM shared_members WHERE conversation_id=$1 AND user_id=$2', [room, bob.userId])).rows[0];
  expect(defaultRole.role).toBe('participant');
  await shared.decline(bob.userId, room);
  await shared.invite(alice.userId, room, {
    email: bob.email,
    role: 'manager'
  });
  const explicitRole = (await fixture.query('SELECT role FROM shared_members WHERE conversation_id=$1 AND user_id=$2', [room, bob.userId])).rows[0];
  expect(explicitRole.role).toBe('manager');
});

test('database checks reject invalid device and grant state', async () => {
  await expect(fixture.query(`INSERT INTO agent_devices(agent_id,owner_id,device_label,platform,executor_type)
    VALUES($1,$2,'bad','linux','shell' )`, [agent, alice.userId])).rejects.toBeTruthy();
  await expect(fixture.query(`INSERT INTO agent_share_grants(agent_id,owner_id,room_id,device_id,grantee_kind,grantee_id,workspace_alias,revision,status,created_by)
    VALUES($1,$2,$3,gen_random_uuid(),'robot',$4,'Website',1,'active',$2)`, [agent, alice.userId, room, bob.userId])).rejects.toBeTruthy();
});
