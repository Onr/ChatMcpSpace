'use strict';

const PROTOCOL_VERSION = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function error(status, message) {
  // Loaded lazily so service.js can consume this module without a circular
  // module initialization returning an incomplete SharedError export.
  const {
    SharedError
  } = require('./service');
  return new SharedError(status, message);
}

function id(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) throw error(400, `Invalid ${name}`);
  return value;
}

function principal(kind, value) {
  if (!['user', 'guest'].includes(kind)) throw error(400, 'Invalid requester kind');
  return {
    kind,
    id: id(value, 'requester')
  };
}

function array(value) {
  return Array.isArray(value) ? [...value] : [];
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Recheck the current device ceiling at every grant use, including grants
// created before a device's workspace or capabilities were narrowed.
function grantWithinDeviceCeiling(grant, device = grant) {
  if (!grant || !device || !Array.isArray(device.workspace_aliases) ||
      !device.workspace_aliases.includes(grant.workspace_alias)) return false;
  const capabilities = object(device.capabilities);
  return ['actions', 'resources', 'destinations'].every(key =>
    Array.isArray(grant[key]) && Array.isArray(capabilities[key]) &&
    (key !== 'actions' || grant[key].length > 0) &&
    grant[key].every(item => typeof item === 'string' && capabilities[key].includes(item)));
}

function grantSnapshot(grant, device) {
  if (!grant || !device) throw error(409, 'Execution grant is unavailable');
  return {
    grantId: id(grant.grant_id || grant.grantId, 'grant'),
    policyRevision: Number(grant.revision),
    expiresAt: grant.expires_at ? new Date(grant.expires_at).toISOString() : null,
    workspaceAlias: grant.workspace_alias || grant.workspaceAlias,
    allowed: array(grant.actions),
    resources: array(grant.resources),
    destinations: array(grant.destinations),
    requiresApproval: array(object(grant.approval_policy).requiresApproval),
    denied: array(object(grant.approval_policy).denied),
    budget: object(grant.budget),
    deviceEpoch: Number(device.credential_epoch),
    deviceId: id(device.device_id, 'device')
  };
}

function isolationFor(device) {
  return device.executor_type === 'container' ? 'project-container' :
    device.executor_type === 'vm' ? 'project-vm' :
      device.executor_type === 'remote_http' ? 'external-unverified' : 'unsupported';
}

function buildContext({
  agent,
  room,
  task,
  requester,
  runtime,
  device,
  grant,
  unsupportedReason = null
}) {
  const actor = principal(requester.kind, requester.id);
  const context = {
    contextVersion: PROTOCOL_VERSION,
    agent: {
      id: id(agent.agent_id, 'agent'),
      ownerUserId: id(agent.user_id || room.owner_id, 'owner')
    },
    conversation: {
      id: id(room.id, 'conversation'),
      visibility: 'all-members',
      membershipVersion: Number(room.membership_version),
      keyVersion: Number(room.key_version)
    },
    request: {
      taskId: id(task.task_id, 'task'),
      requester: actor,
      shareId: grant?.grant_id || null,
      messageIds: array(task.source_message_ids)
    },
    execution: {
      connectorId: id(runtime.runtime_id, 'connector'),
      executorId: device ? id(device.device_id, 'device') : null,
      deviceLabel: device?.device_label || null,
      workspaceAlias: grant?.workspace_alias || null,
      isolation: device ? isolationFor(device) : 'unsupported',
      identityStatus: device?.verification_status || 'unverified'
    },
    authorization: grant ? grantSnapshot(grant, device) : {
      grantId: null,
      policyRevision: null,
      expiresAt: null,
      allowed: [],
      requiresApproval: [],
      denied: [],
      deviceEpoch: null,
      deviceId: null
    }
  };
  if (unsupportedReason) context.execution.unsupportedReason = unsupportedReason;
  return context;
}

function assertTaskContext(context, expected) {
  if (!context || context.contextVersion !== PROTOCOL_VERSION) throw error(409, 'Unsupported execution context version');
  if (expected?.taskId && context.request?.taskId !== expected.taskId) throw error(409, 'Task context mismatch');
  if (expected?.grantId !== undefined && context.authorization?.grantId !== expected.grantId) throw error(409, 'Task grant context mismatch');
  if (expected?.revision !== undefined && Number(context.authorization?.policyRevision) !== Number(expected.revision)) throw error(409, 'Task grant revision mismatch');
  if (expected?.deviceId !== undefined && context.execution?.executorId !== expected.deviceId) throw error(409, 'Task executor context mismatch');
  return context;
}

module.exports = {
  PROTOCOL_VERSION,
  principal,
  grantSnapshot,
  buildContext,
  assertTaskContext,
  grantWithinDeviceCeiling,
  isolationFor
};
