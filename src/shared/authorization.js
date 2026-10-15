'use strict';

const db = require('../db/connection');
const { grantWithinDeviceCeiling } = require('./executionPolicy');
const {
  SharedError,
  check,
  uuid
} = require('./service');

const MAX_LIST_ITEMS = 100;
const MAX_LABEL = 120;
const VALID_EXECUTORS = new Set(['container', 'vm', 'host', 'remote_http', 'unknown']);
const NON_DELEGABLE_ACTIONS = new Set([
  '*',
  'agent.global_stop',
  'agent.model_change',
  'credentials.export',
  'ownership.change',
  'sharing.manage'
]);

function text(value, name, max = MAX_LABEL) {
  check(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, 400, `Invalid ${name}`);
  return value.trim();
}

function list(value, name, max = MAX_LIST_ITEMS) {
  check(Array.isArray(value) && value.length <= max, 400, `Invalid ${name}`);
  const result = [...new Set(value.map(item => text(item, name, MAX_LABEL)))];
  check(!result.some(item => item.includes('*')), 403, `${name} cannot contain wildcards`);
  return result;
}

function object(value, name, maxBytes = 8192) {
  const result = value === undefined || value === null ? {} : value;
  check(result && typeof result === 'object' && !Array.isArray(result), 400, `Invalid ${name}`);
  check(Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes, 400, `${name} is too large`);
  return result;
}

function dateOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  check(Number.isFinite(date.getTime()) && date.getTime() > Date.now(), 400, 'Expiration must be in the future');
  return date;
}

function decode(value, fallback) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  return fallback;
}

async function tx(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function one(client, sql, params) {
  return (await client.query(sql, params)).rows[0];
}

async function ownerAgent(client, ownerId, agentId) {
  const agent = await one(client, 'SELECT * FROM agents WHERE agent_id=$1 AND user_id=$2 FOR UPDATE', [uuid(agentId), uuid(ownerId)]);
  check(agent, 403, 'Agent ownership required');
  return agent;
}

async function ownerRoom(client, ownerId, agentId, roomId) {
  const room = await one(client, `SELECT * FROM shared_conversations
    WHERE id=$1 AND agent_id=$2 AND owner_id=$3 FOR UPDATE`, [uuid(roomId), uuid(agentId), uuid(ownerId)]);
  check(room, 403, 'Shared conversation ownership required');
  return room;
}

async function activeDevice(client, ownerId, agentId, deviceId) {
  const device = await one(client, `SELECT * FROM agent_devices
    WHERE device_id=$1 AND owner_id=$2 AND agent_id=$3 AND revoked_at IS NULL FOR UPDATE`, [uuid(deviceId), uuid(ownerId), uuid(agentId)]);
  check(device, 403, 'Approved execution device required');
  return device;
}

async function securityEvent(client, {
  agentId,
  ownerId,
  actorId = ownerId,
  actorKind = 'user',
  deviceId = null,
  grantId = null,
  eventType,
  metadata = {}
}) {
  await client.query(`INSERT INTO shared_security_events
    (agent_id,owner_id,actor_kind,actor_id,device_id,grant_id,event_type,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [agentId, ownerId, actorKind, actorId, deviceId, grantId, eventType, JSON.stringify(metadata)]);
}

function deviceCapabilities(value) {
  const capabilities = object(value, 'device capabilities');
  return {
    actions: list(capabilities.actions || [], 'device actions'),
    resources: list(capabilities.resources || [], 'device resources'),
    destinations: list(capabilities.destinations || [], 'device destinations')
  };
}

function devicePolicy(input) {
  // Labels and list order are presentation details. Changes to executable
  // scope or runtime identity invalidate every earlier task's epoch.
  const capabilities = input.capabilities || {};
  return JSON.stringify({
    platform: input.platform,
    runnerVersion: input.runnerVersion ?? null,
    executorType: input.executorType,
    workspaceAliases: [...input.workspaceAliases].sort(),
    capabilities: Object.fromEntries(['actions', 'resources', 'destinations'].map(key => [key, [...(capabilities[key] || [])].sort()]))
  });
}

function deviceInput(body) {
  const executorType = body.executorType || 'unknown';
  check(VALID_EXECUTORS.has(executorType), 400, 'Invalid executor type');
  const workspaceAliases = list(body.workspaceAliases || [], 'workspace aliases', 20);
  check(workspaceAliases.length > 0, 400, 'At least one workspace alias is required');
  return {
    deviceLabel: text(body.deviceLabel || body.label, 'device label'),
    platform: text(body.platform, 'platform', 80),
    runnerVersion: body.runnerVersion === undefined || body.runnerVersion === null ? null : text(body.runnerVersion, 'runner version', 80),
    executorType,
    workspaceAliases,
    capabilities: deviceCapabilities(body.capabilities)
  };
}

function grantInput(body, device, current = {}) {
  const actions = list(body.actions ?? decode(current.actions, []), 'grant actions');
  const resources = list(body.resources ?? decode(current.resources, []), 'grant resources');
  const destinations = list(body.destinations ?? decode(current.destinations, []), 'grant destinations');
  check(actions.length > 0, 400, 'At least one grant action is required');
  check(!actions.some(action => NON_DELEGABLE_ACTIONS.has(action)), 403, 'Grant includes a non-delegable action');
  const capabilities = device.capabilities || {};
  check(actions.every(action => (capabilities.actions || []).includes(action)), 403, 'Grant exceeds the device action ceiling');
  check(resources.every(resource => (capabilities.resources || []).includes(resource)), 403, 'Grant exceeds the device resource ceiling');
  check(destinations.every(destination => (capabilities.destinations || []).includes(destination)), 403, 'Grant exceeds the device destination ceiling');
  const workspaceAlias = text(body.workspaceAlias ?? current.workspace_alias, 'workspace alias');
  check((device.workspace_aliases || []).includes(workspaceAlias), 403, 'Workspace is not approved for this device');
  return {
    workspaceAlias,
    actions,
    resources,
    destinations,
    budget: object(body.budget ?? current.budget, 'grant budget', 4096),
    approvalPolicy: object(body.approvalPolicy ?? current.approval_policy, 'approval policy', 4096),
    expiresAt: dateOrNull(body.expiresAt ?? current.expires_at)
  };
}

function presentDevice(row) {
  if (!row) return null;
  return {
    ...row,
    workspaceAliases: decode(row.workspace_aliases, []),
    capabilities: decode(row.capabilities, {})
  };
}

function presentGrant(row) {
  if (!row) return null;
  return {
    ...row,
    grantee: {
      kind: row.grantee_kind,
      id: row.grantee_id
    },
    actions: decode(row.actions, []),
    resources: decode(row.resources, []),
    destinations: decode(row.destinations, []),
    budget: decode(row.budget, {}),
    approvalPolicy: decode(row.approval_policy, {})
  };
}

async function createDevice(ownerId, body) {
  const input = deviceInput(body || {});
  const agentId = uuid(body?.agentId);
  const custodianUserId = body?.custodianUserId ? uuid(body.custodianUserId) : null;
  return tx(async client => {
    await ownerAgent(client, ownerId, agentId);
    if (custodianUserId) check(await one(client, 'SELECT user_id FROM users WHERE user_id=$1', [custodianUserId]), 400, 'Device custodian not found');
    const device = await one(client, `INSERT INTO agent_devices
      (agent_id,owner_id,custodian_user_id,device_label,platform,runner_version,executor_type,verification_status,workspace_aliases,capabilities)
      VALUES($1,$2,$3,$4,$5,$6,$7,'owner-approved',$8,$9) RETURNING *`, [agentId, ownerId, custodianUserId, input.deviceLabel, input.platform, input.runnerVersion, input.executorType, JSON.stringify(input.workspaceAliases), JSON.stringify(input.capabilities)]);
    await securityEvent(client, {
      agentId,
      ownerId,
      deviceId: device.device_id,
      eventType: 'device_created',
      metadata: {
        executorType: input.executorType,
        workspaceAliases: input.workspaceAliases
      }
    });
    return presentDevice(device);
  });
}

async function listDevices(ownerId, agentId = null) {
  const params = [uuid(ownerId)];
  let sql = 'SELECT * FROM agent_devices WHERE owner_id=$1';
  if (agentId) {
    params.push(uuid(agentId));
    sql += ' AND agent_id=$2';
  }
  sql += ' ORDER BY created_at';
  return (await db.query(sql, params)).rows.map(presentDevice);
}

async function updateDevice(ownerId, deviceId, body) {
  let changed = false;
  const result = await tx(async client => {
    const current = await one(client, 'SELECT * FROM agent_devices WHERE device_id=$1 AND owner_id=$2 FOR UPDATE', [uuid(deviceId), uuid(ownerId)]);
    check(current, 404, 'Execution device not found');
    if (body?.revoked === true) { changed = true; return revokeDeviceLocked(client, ownerId, current); }
    const input = deviceInput({
      ...body,
      deviceLabel: body?.deviceLabel ?? current.device_label,
      platform: body?.platform ?? current.platform,
      runnerVersion: body?.runnerVersion ?? current.runner_version,
      executorType: body?.executorType ?? current.executor_type,
      workspaceAliases: body?.workspaceAliases ?? decode(current.workspace_aliases, []),
      capabilities: body?.capabilities ?? decode(current.capabilities, {})
    });
    const previousPolicy = devicePolicy({
      platform: current.platform,
      runnerVersion: current.runner_version,
      executorType: current.executor_type,
      workspaceAliases: decode(current.workspace_aliases, []),
      capabilities: decode(current.capabilities, {})
    });
    const policyChanged = previousPolicy !== devicePolicy(input);
    changed = body?.rotateCredential === true || policyChanged;
    const epoch = body?.rotateCredential === true || policyChanged ? Number(current.credential_epoch) + 1 : current.credential_epoch;
    const device = await one(client, `UPDATE agent_devices SET
      device_label=$2,platform=$3,runner_version=$4,executor_type=$5,
      workspace_aliases=$6,capabilities=$7,credential_epoch=$8,updated_at=NOW()
      WHERE device_id=$1 RETURNING *`, [deviceId, input.deviceLabel, input.platform, input.runnerVersion, input.executorType, JSON.stringify(input.workspaceAliases), JSON.stringify(input.capabilities), epoch]);
    await securityEvent(client, {
      agentId: device.agent_id,
      ownerId,
      deviceId,
      eventType: body?.rotateCredential === true ? 'device_credential_rotated' : 'device_updated',
      metadata: {
        credentialEpoch: epoch,
        policyChanged
      }
    });
    return presentDevice(device);
  });
  if (changed) await require('./taskAuthority').invalidateAuthority({ deviceId, epoch: Number(result.credential_epoch) });
  return result;
}

async function revokeDeviceLocked(client, ownerId, current) {
  const device = await one(client, `UPDATE agent_devices SET
    verification_status='revoked',revoked_at=NOW(),credential_epoch=credential_epoch+1,updated_at=NOW()
    WHERE device_id=$1 RETURNING *`, [current.device_id]);
  await securityEvent(client, {
    agentId: current.agent_id,
    ownerId,
    deviceId: current.device_id,
    eventType: 'device_revoked'
  });
  return presentDevice(device);
}

async function revokeDevice(ownerId, deviceId) {
  const result = await tx(async client => {
    const current = await one(client, 'SELECT * FROM agent_devices WHERE device_id=$1 AND owner_id=$2 FOR UPDATE', [uuid(deviceId), uuid(ownerId)]);
    check(current, 404, 'Execution device not found');
    return revokeDeviceLocked(client, ownerId, current);
  });
  await require('./taskAuthority').invalidateAuthority({ deviceId, epoch: Number(result.credential_epoch) });
  return result;
}

async function validateGrantee(client, kind, id, ownerId, roomId, agentId) {
  if (kind === 'guest') {
    check(process.env.FEATURE_GUEST_SHARING === 'true', 409, 'Guest sharing is not enabled');
    const guest = await one(client, `SELECT gp.guest_id FROM guest_principals gp
      JOIN guest_shares gs ON gs.share_id=gp.share_id
      JOIN shared_guest_members gm ON gm.share_id=gp.share_id AND gm.guest_id=gp.guest_id
      JOIN guest_share_agents ga ON ga.share_id=gp.share_id AND ga.agent_id=$4
      LEFT JOIN guest_share_rooms gr ON gr.share_id=gp.share_id AND gr.guest_id=gp.guest_id AND gr.agent_id=ga.agent_id
      WHERE gp.guest_id=$1 AND gs.owner_id=$2 AND gm.conversation_id=$3 AND gm.status='active'
        AND gp.status<>'revoked' AND gp.public_key IS NOT NULL AND gs.revoked_at IS NULL
        AND (gs.expires_at IS NULL OR gs.expires_at>NOW()) AND ga.removed_at IS NULL
        AND gm.conversation_id=CASE WHEN gs.room_mode='common' THEN ga.room_id ELSE gr.room_id END`,
    [uuid(id), uuid(ownerId), uuid(roomId), uuid(agentId)]);
    check(guest, 403, 'An active guest in this owner-selected room is required');
    return guest.guest_id;
  }
  check(kind === 'user', 400, 'Invalid grant recipient kind');
  const userId = uuid(id);
  // Protocol 2 also requires an explicit bounded grant for an owner's messages
  // in a shared room. The existing owner/room/device and delegation ceilings
  // apply to these grants exactly as they do to collaborators.
  check(await one(client, 'SELECT user_id FROM users WHERE user_id=$1', [userId]), 400, 'Grant recipient not found');
  return userId;
}

async function createGrant(ownerId, body) {
  const agentId = uuid(body?.agentId);
  const roomId = uuid(body?.roomId);
  const deviceId = uuid(body?.deviceId);
  const granteeKind = body?.granteeKind || body?.grantee?.kind || 'user';
  const granteeId = body?.granteeId || body?.grantee?.id;
  return tx(async client => {
    if (granteeKind === 'guest') {
      // Guest mutations lock share before agent/room. Keep the same order.
      check(process.env.FEATURE_GUEST_SHARING === 'true', 409, 'Guest sharing is not enabled');
      await client.query(`SELECT gs.share_id FROM guest_shares gs JOIN guest_principals gp ON gp.share_id=gs.share_id
        WHERE gp.guest_id=$1 FOR SHARE OF gs`, [uuid(granteeId)]);
    }
    await ownerAgent(client, ownerId, agentId);
    await ownerRoom(client, ownerId, agentId, roomId);
    const device = await activeDevice(client, ownerId, agentId, deviceId);
    const recipientId = await validateGrantee(client, granteeKind, granteeId, ownerId, roomId, agentId);
    const input = grantInput(body, device);
    const grant = await one(client, `INSERT INTO agent_share_grants
      (agent_id,owner_id,room_id,device_id,grantee_kind,grantee_id,workspace_alias,actions,resources,destinations,budget,approval_policy,expires_at,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$2) RETURNING *`, [agentId, ownerId, roomId, deviceId, granteeKind, recipientId, input.workspaceAlias, JSON.stringify(input.actions), JSON.stringify(input.resources), JSON.stringify(input.destinations), JSON.stringify(input.budget), JSON.stringify(input.approvalPolicy), input.expiresAt]);
    await securityEvent(client, {
      agentId,
      ownerId,
      deviceId,
      grantId: grant.grant_id,
      eventType: 'grant_created',
      metadata: {
        granteeKind,
        granteeId: recipientId,
        roomId,
        actions: input.actions,
        revision: grant.revision
      }
    });
    return presentGrant(grant);
  });
}

async function listGrants(ownerId, agentId = null) {
  const params = [uuid(ownerId)];
  let sql = `SELECT g.*,d.device_label,a.agent_name FROM agent_share_grants g
    JOIN agent_devices d ON d.device_id=g.device_id JOIN agents a ON a.agent_id=g.agent_id
    WHERE g.owner_id=$1`;
  if (agentId) {
    params.push(uuid(agentId));
    sql += ' AND g.agent_id=$2';
  }
  sql += ' ORDER BY g.created_at DESC';
  return (await db.query(sql, params)).rows.map(presentGrant);
}

async function updateGrant(ownerId, grantId, body) {
  const result = await tx(async client => {
    const current = await one(client, 'SELECT * FROM agent_share_grants WHERE grant_id=$1 AND owner_id=$2 FOR UPDATE', [uuid(grantId), uuid(ownerId)]);
    check(current, 404, 'Share grant not found');
    const deviceId = body?.deviceId ? uuid(body.deviceId) : current.device_id;
    const device = await activeDevice(client, ownerId, current.agent_id, deviceId);
    const input = grantInput(body || {}, device, current);
    const grant = await one(client, `UPDATE agent_share_grants SET
      device_id=$2,workspace_alias=$3,actions=$4,resources=$5,destinations=$6,budget=$7,approval_policy=$8,
      expires_at=$9,revision=revision+1,status='active',revoked_at=NULL,updated_at=NOW()
      WHERE grant_id=$1 RETURNING *`, [grantId, deviceId, input.workspaceAlias, JSON.stringify(input.actions), JSON.stringify(input.resources), JSON.stringify(input.destinations), JSON.stringify(input.budget), JSON.stringify(input.approvalPolicy), input.expiresAt]);
    await securityEvent(client, {
      agentId: current.agent_id,
      ownerId,
      deviceId,
      grantId,
      eventType: 'grant_updated',
      metadata: {
        revision: grant.revision
      }
    });
    return presentGrant(grant);
  });
  await require('./taskAuthority').invalidateAuthority({ grantId, revision: Number(result.revision) });
  return result;
}

async function revokeGrant(ownerId, grantId) {
  const result = await tx(async client => {
    const current = await one(client, 'SELECT * FROM agent_share_grants WHERE grant_id=$1 AND owner_id=$2 FOR UPDATE', [uuid(grantId), uuid(ownerId)]);
    check(current, 404, 'Share grant not found');
    const grant = await one(client, `UPDATE agent_share_grants SET
      status='revoked',revoked_at=NOW(),revision=revision+1,updated_at=NOW()
      WHERE grant_id=$1 RETURNING *`, [grantId]);
    await securityEvent(client, {
      agentId: current.agent_id,
      ownerId,
      deviceId: current.device_id,
      grantId,
      eventType: 'grant_revoked',
      metadata: {
        revision: grant.revision
      }
    });
    return presentGrant(grant);
  });
  await require('./taskAuthority').invalidateAuthority({ grantId, revision: Number(result.revision) });
  return result;
}

async function currentGrant({ requesterKind = 'user', requesterId, agentId, roomId, revision = null, grantId = null, deviceId = null }) {
  if (requesterKind === 'guest') {
    if (process.env.FEATURE_GUEST_SHARING !== 'true') return null;
    const guest = await one(db, `SELECT gm.guest_id FROM shared_guest_members gm
      JOIN guest_principals gp ON gp.guest_id=gm.guest_id AND gp.share_id=gm.share_id
      JOIN guest_shares gs ON gs.share_id=gm.share_id
      JOIN guest_share_agents ga ON ga.share_id=gm.share_id AND ga.agent_id=$3
      LEFT JOIN guest_share_rooms gr ON gr.share_id=gm.share_id AND gr.guest_id=gp.guest_id AND gr.agent_id=ga.agent_id
      WHERE gm.guest_id=$1 AND gm.conversation_id=$2 AND gm.status='active' AND gp.status<>'revoked'
        AND gs.revoked_at IS NULL AND (gs.expires_at IS NULL OR gs.expires_at>NOW()) AND ga.removed_at IS NULL
        AND gm.conversation_id=CASE WHEN gs.room_mode='common' THEN ga.room_id ELSE gr.room_id END`,
    [uuid(requesterId), uuid(roomId), uuid(agentId)]);
    if (!guest) return null;
  }
  const params = [requesterKind, uuid(requesterId), uuid(agentId), uuid(roomId)];
  const filters = [
    'g.grantee_kind=$1',
    'g.grantee_id=$2',
    'g.agent_id=$3',
    'g.room_id=$4'
  ];
  if (grantId) {
    params.push(uuid(grantId));
    filters.push(`g.grant_id=$${params.length}`);
  }
  if (deviceId) {
    params.push(uuid(deviceId));
    filters.push(`g.device_id=$${params.length}`);
  }
  const grant = await one(db, `SELECT g.*,d.device_label,d.workspace_aliases,d.capabilities,d.credential_epoch,d.revoked_at AS device_revoked_at
    FROM agent_share_grants g JOIN agent_devices d ON d.device_id=g.device_id
    WHERE ${filters.join(' AND ')}
      AND g.status='active' AND d.revoked_at IS NULL
      AND d.verification_status IN ('owner-approved','isolation-tested')
      AND (g.expires_at IS NULL OR g.expires_at>NOW())`, params);
  if (!grant || !grantWithinDeviceCeiling(grant) || revision !== null && Number(grant.revision) !== Number(revision)) return null;
  return presentGrant(grant);
}

async function authorizeGrant(input) {
  const grant = await currentGrant(input);
  check(grant, 403, 'Current share grant is unavailable');
  if (input.action) {
    check(grant.actions.includes(input.action), 403, 'Action is outside the share grant');
    check(!(grant.approvalPolicy.denied || []).includes(input.action), 403, 'Action is denied by the share grant');
    // A boolean or self-issued approval supplied by a caller cannot replace
    // the task/digest/revision/epoch-bound action approval contract.
    check(!(grant.approvalPolicy.requiresApproval || []).includes(input.action), 403, 'A bound action approval is required');
  }
  if (input.resource) check(grant.resources.includes(input.resource), 403, 'Resource is outside the share grant');
  if (input.destination) check(grant.destinations.includes(input.destination), 403, 'Destination is outside the share grant');
  return grant;
}

module.exports = {
  MAX_LIST_ITEMS,
  createDevice,
  listDevices,
  updateDevice,
  revokeDevice,
  createGrant,
  listGrants,
  updateGrant,
  revokeGrant,
  currentGrant,
  authorizeGrant,
  SharedError
};
