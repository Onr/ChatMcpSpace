const fs = require('fs');
const path = require('path');
const { query } = require('../db/connection');

// Agents run autonomously (full-auto) but inside a workspace-scoped sandbox by
// default. Unsandboxed operation (sandbox_mode 'none') must be an explicit
// per-agent choice backed by a matching allowed_permissions grant.
const DEFAULT_AGENT_API_CONFIG = Object.freeze({
  model_provider: 'codex',
  model: 'gpt-5.6-terra',
  approval_mode: 'full-auto',
  sandbox_mode: 'workspace-write'
});

const DEFAULT_DASHBOARD_CONFIG = Object.freeze({
  model_provider: 'codex',
  model: 'default',
  approval_mode: 'suggest',
  sandbox_mode: 'workspace-write'
});

function sanitizeAgentFolder(agentName) {
  return String(agentName || '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clonePlainObject(value) {
  return isPlainObject(value) ? JSON.parse(JSON.stringify(value)) : {};
}

function hasOwnKeys(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function normalizeRuntimeConfig(config, defaults = DEFAULT_AGENT_API_CONFIG) {
  const normalized = {
    ...defaults
  };

  if (!isPlainObject(config)) {
    return normalized;
  }

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        normalized[key] = trimmed;
      }
    } else if (typeof value === 'boolean' || typeof value === 'number' || value === null) {
      normalized[key] = value;
    } else if (Array.isArray(value) || isPlainObject(value)) {
      normalized[key] = JSON.parse(JSON.stringify(value));
    }
  }

  if (normalized.sandbox_mode === 'danger-full-access') {
    normalized.sandbox_mode = 'none';
  }

  // Older model syncs stored "<id>\t<label>" lines from `agy models` as the
  // model value; keep only the id so the CLI receives a valid --model.
  if (typeof normalized.model === 'string' && normalized.model.includes('\t')) {
    normalized.model = normalized.model.split('\t')[0].trim() || 'default';
  }

  return normalized;
}

function normalizeAllowedPermissions(allowedPermissions) {
  return clonePlainObject(allowedPermissions);
}

function findAgentChatspaceDir(agentFolder) {
  if (!agentFolder) {
    return null;
  }

  const possiblePaths = [
    path.join(process.cwd(), '.chatspace', agentFolder),
    path.join(process.env.HOME || '', '.chatspace', agentFolder),
    path.join(process.cwd(), 'chatspace', agentFolder),
    path.join(process.env.HOME || '', 'chatspace', agentFolder)
  ];

  for (const candidate of possiblePaths) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function loadFilesystemRuntimeState(agentName) {
  const agentFolder = sanitizeAgentFolder(agentName);
  const agentDir = findAgentChatspaceDir(agentFolder);
  const result = {
    agentDir,
    config: {},
    allowedPermissions: {}
  };

  if (!agentDir) {
    return result;
  }

  const configPath = path.join(agentDir, 'agent_state', 'agent_config.json');
  const allowedPath = path.join(agentDir, 'agent_state', 'allowed_permissions.json');

  if (fs.existsSync(configPath)) {
    try {
      result.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (_) {
      result.config = {};
    }
  }

  if (fs.existsSync(allowedPath)) {
    try {
      result.allowedPermissions = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
    } catch (_) {
      result.allowedPermissions = {};
    }
  }

  return result;
}

async function loadAgentRuntimeState({
  userId,
  agentId,
  agentName,
  defaults = DEFAULT_AGENT_API_CONFIG
}) {
  let dbConfig = {};
  let dbAllowedPermissions = {};

  if (agentId || (userId && agentName)) {
    const params = [];
    let whereClause = '';

    if (agentId) {
      params.push(agentId);
      whereClause = `agent_id = $${params.length}`;
    } else {
      params.push(userId);
      params.push(agentName);
      whereClause = `user_id = $1 AND agent_name = $2`;
    }

    const result = await query(
      `SELECT runtime_config, allowed_permissions
       FROM agents
       WHERE ${whereClause}`,
      params
    );

    if (result.rows.length > 0) {
      dbConfig = normalizeRuntimeConfig(result.rows[0].runtime_config, {});
      dbAllowedPermissions = normalizeAllowedPermissions(result.rows[0].allowed_permissions);
    }
  }

  const fileState = loadFilesystemRuntimeState(agentName);
  const mergedConfig = normalizeRuntimeConfig(
    {
      ...normalizeRuntimeConfig(fileState.config, {}),
      ...dbConfig
    },
    defaults
  );
  const mergedAllowedPermissions = hasOwnKeys(dbAllowedPermissions)
    ? dbAllowedPermissions
    : normalizeAllowedPermissions(fileState.allowedPermissions);

  return {
    agentDir: fileState.agentDir,
    config: mergedConfig,
    allowedPermissions: mergedAllowedPermissions
  };
}

async function persistAgentRuntimeState({
  agentId,
  config,
  allowedPermissions,
  dbClient = null
}) {
  if (!agentId) {
    throw new Error('agentId is required');
  }

  const runner = dbClient && typeof dbClient.query === 'function'
    ? dbClient.query.bind(dbClient)
    : query;

  const normalizedConfig = config === undefined ? null : normalizeRuntimeConfig(config, {});
  const normalizedAllowedPermissions = allowedPermissions === undefined ? null : normalizeAllowedPermissions(allowedPermissions);

  await runner(
    `UPDATE agents
     SET runtime_config = COALESCE($2::jsonb, runtime_config),
         allowed_permissions = COALESCE($3::jsonb, allowed_permissions)
     WHERE agent_id = $1`,
    [
      agentId,
      normalizedConfig === null ? null : JSON.stringify(normalizedConfig),
      normalizedAllowedPermissions === null ? null : JSON.stringify(normalizedAllowedPermissions)
    ]
  );

  return {
    config: normalizedConfig,
    allowedPermissions: normalizedAllowedPermissions
  };
}

function syncRuntimeStateToFilesystem({ agentDir, config, allowedPermissions }) {
  if (!agentDir) {
    return { synced: false };
  }

  const stateDir = path.join(agentDir, 'agent_state');
  fs.mkdirSync(stateDir, { recursive: true });

  if (config) {
    fs.writeFileSync(
      path.join(stateDir, 'agent_config.json'),
      JSON.stringify(normalizeRuntimeConfig(config, DEFAULT_AGENT_API_CONFIG), null, 2)
    );
  }

  if (allowedPermissions) {
    fs.writeFileSync(
      path.join(stateDir, 'allowed_permissions.json'),
      JSON.stringify(normalizeAllowedPermissions(allowedPermissions), null, 2)
    );
  }

  return { synced: true };
}

module.exports = {
  DEFAULT_AGENT_API_CONFIG,
  DEFAULT_DASHBOARD_CONFIG,
  findAgentChatspaceDir,
  loadAgentRuntimeState,
  normalizeAllowedPermissions,
  normalizeRuntimeConfig,
  persistAgentRuntimeState,
  sanitizeAgentFolder,
  syncRuntimeStateToFilesystem
};
