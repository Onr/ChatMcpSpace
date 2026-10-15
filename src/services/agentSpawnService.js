/**
 * Agent Spawn Service
 * Handles independent agent spawning (parent → child) and self-termination.
 *
 * Features:
 * - Spawn a new child agent with its own folder, config, and chat thread
 * - Enforce depth (max 3), fan-out (max 10), and global cap (max 75) limits
 * - Permission inheritance (child ≤ parent)
 * - Self-termination with safe child re-parenting
 * - Lineage tracking via DB + lineage.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { query, getClient } = require('../db/connection');
const { archiveAgent } = require('./archiveService');
const { logInfo, logError, logWarn } = require('../utils/logger');
const {
  DEFAULT_AGENT_API_CONFIG,
  normalizeAllowedPermissions,
  normalizeRuntimeConfig,
  persistAgentRuntimeState
} = require('./agentRuntimeConfigService');
const {
  generateAgentRunner,
  generateMessageHelperPython,
  generateOneshotInstructions,
  generateAgentInstructions,
  generateRichFormSkill
} = require('../utils/apiGuideGenerator');

// ─── Configurable limits ────────────────────────────────────────────────────
const SPAWN_LIMITS = {
  MAX_DEPTH: 3,            // 0=root → 3=great-grandchild
  MAX_CHILDREN: 10,        // per agent
  GLOBAL_AGENT_CAP: 75,    // per user, total active agents
  SPAWN_COOLDOWN_MS: 60000 // 1 minute between spawns per agent
};

// Safe-by-default permission ceiling for agents that inherit no explicit
// permissions. Agents stay fully autonomous inside a workspace-scoped sandbox;
// the flags that drop the sandbox or skip the provider's permission system
// entirely (--dangerously-*, --no-sandbox, --allow-all, danger-full-access)
// must be granted explicitly per agent via the dashboard or agent-cli.
const DEFAULT_LOCAL_AGENT_ALLOWED_PERMISSIONS = {
  inter_agent: { enabled: true, mode: 'listen_all', groups: [] },
  claude: {
    '--permission-mode': ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
    '--dangerously-skip-permissions': false
  },
  codex: {
    '--sandbox': ['workspace-write', 'read-only'],
    '--dangerously-bypass-approvals-and-sandbox': false
  },
  gemini: {
    '--sandbox': true,
    '--no-sandbox': false,
    '--yolo': true
  },
  copilot: {
    '--allow-all': false,
    '--allow-all-tools': false,
    '--allow-all-paths': false
  },
  antigravity: {
    '--sandbox': ['workspace-write', 'read-only'],
    '--dangerously-skip-permissions': false
  },
  pi: { enabled: true },
  kilo: { '--auto': true },
  ollama: {
    '--sandbox': ['workspace-write', 'read-only'],
    '--dangerously-bypass-approvals-and-sandbox': false
  },
  openrouter: {
    '--sandbox': ['workspace-write', 'read-only'],
    '--dangerously-bypass-approvals-and-sandbox': false
  },
  lmstudio: {
    '--sandbox': ['workspace-write', 'read-only'],
    '--dangerously-bypass-approvals-and-sandbox': false
  }
};

function buildDefaultLocalAgentAllowedPermissions() {
  return JSON.parse(JSON.stringify(DEFAULT_LOCAL_AGENT_ALLOWED_PERMISSIONS));
}

/**
 * Keep sandbox_mode 'none' (no OS sandbox) only when the permissions ceiling
 * explicitly allows running the provider unsandboxed. Otherwise fall back to
 * the most permissive allowed sandbox, so agent-runner's validate_config
 * accepts the config instead of refusing to run (claude and gemini hard-fail
 * on a disallowed unsandboxed config rather than clamping it).
 * NOTE: agent-runner.sh maps 'none' → 'danger-full-access' for validation,
 * so the two must be treated as equivalent here.
 */
function clampSandboxToPermissionCeiling(provider, sandboxMode, allowedPermissions) {
  if (sandboxMode !== 'none') {
    return sandboxMode;
  }
  const providerPerms = allowedPermissions ? allowedPermissions[provider] : null;
  if (!providerPerms || typeof providerPerms !== 'object') {
    return sandboxMode;
  }
  const sandboxModes = providerPerms['--sandbox'];
  if (Array.isArray(sandboxModes)) {
    if (sandboxModes.includes('none') || sandboxModes.includes('danger-full-access')) {
      return sandboxMode;
    }
    return sandboxModes[0] || 'workspace-write';
  }
  if (provider === 'claude') {
    return providerPerms['--dangerously-skip-permissions'] === true ? sandboxMode : 'workspace-write';
  }
  if (provider === 'gemini') {
    return providerPerms['--no-sandbox'] === true ? sandboxMode : 'workspace-write';
  }
  if (provider === 'copilot') {
    const allowAll = providerPerms['--allow-all'] === true;
    const allowSplit = providerPerms['--allow-all-tools'] === true
      && providerPerms['--allow-all-paths'] === true;
    return allowAll || allowSplit ? sandboxMode : 'workspace-write';
  }
  return sandboxMode;
}

// In-memory spawn cooldown tracker  { agentId → lastSpawnTimestamp }
const spawnCooldowns = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sanitise an agent name into a safe folder name.
 * Matches the pattern used by apiGuideGenerator.
 */
function sanitizeFolderName(agentName) {
  return agentName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

function isValidSpawnAgentName(agentName) {
  if (typeof agentName !== 'string') {
    return false;
  }

  const trimmed = agentName.trim();
  return trimmed.length > 0 && !trimmed.startsWith('-');
}

function collectPreferredBinDirs(env = process.env) {
  const dirs = [];
  const seen = new Set();
  const addDir = (dir) => {
    if (!dir || seen.has(dir)) {
      return;
    }
    seen.add(dir);
    dirs.push(dir);
  };

  const homeCandidates = new Set();
  [
    env.HOME,
    process.env.HOME,
    os.homedir && os.homedir()
  ].forEach((homeDir) => {
    if (homeDir) {
      homeCandidates.add(homeDir);
    }
  });

  [env.SUDO_USER, process.env.SUDO_USER].forEach((sudoUser) => {
    if (sudoUser) {
      homeCandidates.add(path.join('/home', sudoUser));
    }
  });

  try {
    if (fs.existsSync('/home')) {
      fs.readdirSync('/home', { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .forEach((entry) => homeCandidates.add(path.join('/home', entry.name)));
    }
  } catch (error) {
    logWarn('agent.spawn.collect_home_dirs', { error: error.message });
  }

  for (const homeDir of homeCandidates) {
    addDir(path.join(homeDir, '.local', 'bin'));
    addDir(path.join(homeDir, '.npm-global', 'bin'));
    addDir(path.join(homeDir, '.cargo', 'bin'));

    const nvmVersionsRoot = path.join(homeDir, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmVersionsRoot)) {
      try {
        fs.readdirSync(nvmVersionsRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(nvmVersionsRoot, entry.name, 'bin'))
          .filter((binDir) => fs.existsSync(binDir))
          .sort()
          .reverse()
          .forEach(addDir);
      } catch (error) {
        logWarn('agent.spawn.collect_bin_dirs', { error: error.message });
      }
    }
  }

  if (env.NVM_BIN) {
    addDir(env.NVM_BIN);
  }

  if (process.execPath) {
    addDir(path.dirname(process.execPath));
  }

  return dirs;
}

function resolveCliBinary(binaryName, env = process.env) {
  const basePath = env.PATH || '';
  const candidateDirs = collectPreferredBinDirs(env);
  const pathEntries = [
    ...candidateDirs,
    ...basePath.split(path.delimiter).filter(Boolean)
  ];
  const seen = new Set();

  for (const dir of pathEntries) {
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    const candidate = path.join(dir, binaryName);
    if (fs.existsSync(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (_) {
        // Keep searching until we find an executable candidate.
      }
    }
  }

  return null;
}

function buildAgentLaunchEnv(env = process.env) {
  const mergedPathEntries = [
    ...collectPreferredBinDirs(env),
    ...(env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter).filter(Boolean)
  ];
  const orderedPathEntries = [];
  const seen = new Set();

  for (const entry of mergedPathEntries) {
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    orderedPathEntries.push(entry);
  }

  const launchEnv = {
    ...env,
    HOME: env.HOME || '/root',
    PATH: orderedPathEntries.join(path.delimiter)
  };

  const codexBinary = resolveCliBinary('codex', launchEnv);
  if (codexBinary) {
    launchEnv.CODEX_BIN = codexBinary;
  }

  return launchEnv;
}

/**
 * Resolve the chatspace root directory.
 * Defaults to project-root `.chatspace/` for new users.
 */
function getChatspaceRoot() {
  // Prefer env override
  if (process.env.CHATSPACE_DIR) {
    return process.env.CHATSPACE_DIR;
  }
  // Walk from project root (two levels up from src/services/)
  const projectRoot = path.resolve(__dirname, '..', '..');
  return path.join(projectRoot, '.chatspace');
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate that an agent is allowed to spawn a child.
 * Returns { valid, error } — error is a human-readable string.
 */
async function validateSpawnRequest(userId, parentAgentId, childAgentName) {
  if (!isValidSpawnAgentName(childAgentName)) {
    return {
      valid: false,
      error: 'Invalid child agent name. Names must not be empty or begin with "-".'
    };
  }

  // 1. Fetch parent agent
  const parentResult = await query(
    `SELECT agent_id, agent_name, can_spawn, spawn_depth, user_id
     FROM agents
     WHERE agent_id = $1 AND user_id = $2`,
    [parentAgentId, userId]
  );

  if (parentResult.rows.length === 0) {
    return { valid: false, error: 'Parent agent not found or access denied' };
  }

  const parent = parentResult.rows[0];

  // 2. can_spawn permission
  if (!parent.can_spawn) {
    return { valid: false, error: 'Parent agent does not have spawn permission (can_spawn = false)' };
  }

  // 3. Depth limit
  const parentDepth = parent.spawn_depth == null ? 0 : parent.spawn_depth;
  if (parentDepth >= SPAWN_LIMITS.MAX_DEPTH) {
    return {
      valid: false,
      error: `Maximum spawn depth reached (${SPAWN_LIMITS.MAX_DEPTH}). Parent is at depth ${parentDepth}.`
    };
  }

  // 4. Fan-out limit (active children of this parent)
  const childCountResult = await query(
    `SELECT COUNT(*)::int AS count
     FROM agents
     WHERE parent_agent_id = $1`,
    [parentAgentId]
  );
  const childCount = childCountResult.rows[0].count;
  if (childCount >= SPAWN_LIMITS.MAX_CHILDREN) {
    return {
      valid: false,
      error: `Parent already has ${childCount} children (max ${SPAWN_LIMITS.MAX_CHILDREN}).`
    };
  }

  // 5. Global cap per user
  const globalCountResult = await query(
    `SELECT COUNT(*)::int AS count
     FROM agents
     WHERE user_id = $1`,
    [userId]
  );
  const totalAgents = globalCountResult.rows[0].count;
  if (totalAgents >= SPAWN_LIMITS.GLOBAL_AGENT_CAP) {
    return {
      valid: false,
      error: `Global agent cap reached (${SPAWN_LIMITS.GLOBAL_AGENT_CAP} active agents).`
    };
  }

  // 6. Unique child name per user (checked before cooldown for better errors)
  const nameCheckResult = await query(
    `SELECT 1 FROM agents WHERE user_id = $1 AND agent_name = $2`,
    [userId, childAgentName.trim()]
  );
  if (nameCheckResult.rows.length > 0) {
    return {
      valid: false,
      error: `An agent named "${childAgentName}" already exists for this user.`
    };
  }

  // 7. Rate limit (cooldown)
  const lastSpawn = spawnCooldowns.get(parentAgentId);
  if (lastSpawn && (Date.now() - lastSpawn) < SPAWN_LIMITS.SPAWN_COOLDOWN_MS) {
    const waitSec = Math.ceil((SPAWN_LIMITS.SPAWN_COOLDOWN_MS - (Date.now() - lastSpawn)) / 1000);
    return {
      valid: false,
      error: `Spawn cooldown active. Try again in ${waitSec}s.`
    };
  }

  return { valid: true, parentDepth };
}

// ─── Spawn Agent ────────────────────────────────────────────────────────────

/**
 * Spawn a new independent child agent.
 *
 * @param {Object} params
 * @param {string} params.userId              – owner user id
 * @param {string} params.parentAgentId       – parent agent uuid
 * @param {string} params.childAgentName      – desired name for child
 * @param {string} params.initialInstructions – seeded instructions
 * @param {string} [params.modelProvider]     – model provider override (default: inherit)
 * @param {string} [params.model]             – model name override (default: inherit)
 * @param {string} [params.projectPath]       – working directory override for spawned child
 * @param {boolean} [params.canSpawn=false]   – allow child to spawn its own children
 * @param {string[]|undefined} [params.groupSelectors] – group IDs/names; undefined inherits parent groups, [] leaves ungrouped
 * @returns {Promise<Object>} spawned child agent info
 */
async function spawnAgent({
  userId,
  parentAgentId,
  childAgentName,
  initialInstructions,
  modelProvider,
  model,
  projectPath,
  canSpawn = false,
  groupSelectors
}) {
  // ── Validate ──────────────────────────────────────────────────────────
  const validation = await validateSpawnRequest(userId, parentAgentId, childAgentName);
  if (!validation.valid) {
    throw new SpawnError(validation.error, 'SPAWN_VALIDATION_FAILED');
  }

  const childDepth = (validation.parentDepth == null ? 0 : validation.parentDepth) + 1;
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const parentConfig = await readParentConfig(parentAgentId);
    const resolvedProjectPath = typeof projectPath === 'string' && projectPath.trim()
      ? projectPath.trim()
      : null;
    const runtimeState = buildChildRuntimeState({
      parentConfig,
      modelProvider,
      model,
      projectPath: resolvedProjectPath
    });

    // ── 1. Compute next position ────────────────────────────────────────
    const posResult = await client.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
       FROM agents WHERE user_id = $1`,
      [userId]
    );
    const nextPosition = posResult.rows[0].next_pos;

    // ── 2. Insert child agent row ───────────────────────────────────────
    const insertResult = await client.query(
      `INSERT INTO agents
         (user_id, agent_name, agent_type, position,
          parent_agent_id, spawn_depth, initial_instructions,
          auto_spawned, can_spawn, inter_agent_mode)
       VALUES ($1, $2, 'standard', $3,
               $4, $5, $6,
               TRUE, $7, 'listen_all')
       RETURNING agent_id, agent_name, spawn_depth, created_at`,
      [userId, childAgentName.trim(), nextPosition,
       parentAgentId, childDepth, initialInstructions || '',
       canSpawn]
    );

    const childAgent = insertResult.rows[0];

    // Keep children with their creator by default. Callers can override this
    // with one or more group IDs/names, or pass an empty list for no groups.
    let selectedGroups;
    if (groupSelectors === undefined) {
      const inheritedGroups = await client.query(
        `SELECT g.group_id, g.group_name
         FROM agent_group_members gm
         JOIN agent_groups g ON g.group_id = gm.group_id
         WHERE gm.agent_id = $1 AND g.user_id = $2
         ORDER BY g.group_name ASC`,
        [parentAgentId, userId]
      );
      selectedGroups = inheritedGroups.rows;
    } else {
      selectedGroups = [];
      const seenGroupIds = new Set();
      for (const selector of groupSelectors) {
        const groupResult = await client.query(
          `SELECT group_id, group_name
           FROM agent_groups
           WHERE user_id = $1 AND (group_id::text = $2 OR group_name = $2)`,
          [userId, selector]
        );
        if (groupResult.rows.length === 0) {
          throw new SpawnError(`Group "${selector}" was not found for this user.`, 'SPAWN_GROUP_NOT_FOUND');
        }
        const group = groupResult.rows[0];
        if (!seenGroupIds.has(group.group_id)) {
          seenGroupIds.add(group.group_id);
          selectedGroups.push(group);
        }
      }
    }

    for (const group of selectedGroups) {
      await client.query(
        `INSERT INTO agent_group_members (group_id, agent_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [group.group_id, childAgent.agent_id]
      );
    }

    runtimeState.allowedPermissions.inter_agent = {
      ...(runtimeState.allowedPermissions.inter_agent || {}),
      groups: selectedGroups.map(group => group.group_name)
    };

    await persistAgentRuntimeState({
      agentId: childAgent.agent_id,
      config: runtimeState.agentConfig,
      allowedPermissions: runtimeState.allowedPermissions,
      dbClient: client
    });

    await client.query('COMMIT');

    // ── 4. Update cooldown ──────────────────────────────────────────────
    spawnCooldowns.set(parentAgentId, Date.now());

    logInfo('agent.spawn', {
      parentAgentId,
      childAgentId: childAgent.agent_id,
      childAgentName: childAgent.agent_name,
      spawnDepth: childDepth,
      launchMode: 'local_only'
    });

    return {
      agentId: childAgent.agent_id,
      agentName: childAgent.agent_name,
      spawnDepth: childAgent.spawn_depth,
      parentAgentId,
      createdAt: childAgent.created_at,
      groups: selectedGroups.map(group => ({
        groupId: group.group_id,
        groupName: group.group_name
      })),
      loopPid: null,
      logFile: null,
      runtime: {
        sameMachineAsParent: true,
        launchMode: 'local_only',
        serverSideLaunch: false,
        projectPath: runtimeState.projectPath,
        config: runtimeState.agentConfig,
        allowedPermissions: runtimeState.allowedPermissions,
        listener: 'local agent-runner polls /api/agent/responses and /api/agent/messages/direct'
      }
    };

  } catch (error) {
    await client.query('ROLLBACK');
    logError('agent.spawn_failed', { parentAgentId, childAgentName, error: error.message });
    throw error;
  } finally {
    client.release();
  }
}

// ─── Folder Initialization ──────────────────────────────────────────────────

/**
 * Read parent agent's config from its chatspace folder.
 * Searches multiple candidate folder names (sanitized name, position, agent_id)
 * and multiple chatspace roots (cwd, HOME, tmp subdirs).
 * Returns a best-effort config object.
 */
async function readParentConfig(parentAgentId) {
  const parentResult = await query(
    'SELECT agent_name, position, runtime_config, allowed_permissions FROM agents WHERE agent_id = $1',
    [parentAgentId]
  );

  if (parentResult.rows.length === 0) return {};

  const { agent_name, position } = parentResult.rows[0];

  // Try multiple candidate folder names for the parent
  const candidates = [
    sanitizeFolderName(agent_name),
    String(position),
    String(parentAgentId)
  ].filter(Boolean);

  // Try multiple chatspace root locations
  const chatspaceRoots = [getChatspaceRoot()];
  const cwdDotChatspace = path.join(process.cwd(), '.chatspace');
  const homeDotChatspace = path.join(process.env.HOME || '', '.chatspace');
  const cwdChatspace = path.join(process.cwd(), 'chatspace');
  const homeChatspace = path.join(process.env.HOME || '', 'chatspace');
  [cwdDotChatspace, homeDotChatspace, cwdChatspace, homeChatspace].forEach((root) => {
    if (!chatspaceRoots.includes(root)) chatspaceRoots.push(root);
  });
  // Also check tmp subdirectories (development/testing)
  const tmpDir = path.join(process.cwd(), 'tmp');
  try {
    if (fs.existsSync(tmpDir)) {
      fs.readdirSync(tmpDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .forEach((d) => {
          chatspaceRoots.push(path.join(tmpDir, d.name, '.chatspace'));
          chatspaceRoots.push(path.join(tmpDir, d.name, 'chatspace'));
        });
    }
  } catch (_) { /* ignore */ }

  // Find the first existing parent directory
  let parentDir = null;
  for (const root of chatspaceRoots) {
    for (const candidate of candidates) {
      const tryDir = path.join(root, candidate);
      if (fs.existsSync(path.join(tryDir, '.env'))) {
        parentDir = tryDir;
        break;
      }
    }
    if (parentDir) break;
  }

  if (!parentDir) {
    logWarn('agent.spawn.read_parent_config', {
      warning: 'Parent chatspace folder not found',
      candidates,
      roots: chatspaceRoots
    });
    return {};
  }

  const configPath = path.join(parentDir, 'agent_state', 'agent_config.json');
  const permPath = path.join(parentDir, 'agent_state', 'allowed_permissions.json');
  const envPath = path.join(parentDir, '.env');

  const config = {};
  const parentRow = parentResult.rows[0];

  if (parentRow.runtime_config && typeof parentRow.runtime_config === 'object') {
    config.agentConfig = normalizeRuntimeConfig(parentRow.runtime_config, DEFAULT_AGENT_API_CONFIG);
  }

  if (parentRow.allowed_permissions && typeof parentRow.allowed_permissions === 'object') {
    config.allowedPermissions = normalizeAllowedPermissions(parentRow.allowed_permissions);
  }

  try {
    if (fs.existsSync(configPath)) {
      config.agentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    logWarn('agent.spawn.read_parent_config', { error: e.message });
  }

  try {
    if (fs.existsSync(permPath)) {
      config.allowedPermissions = JSON.parse(fs.readFileSync(permPath, 'utf8'));
    }
  } catch (e) {
    logWarn('agent.spawn.read_parent_permissions', { error: e.message });
  }

  // Read parent .env to inherit USER_PASSWORD
  try {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const pwdMatch = envContent.match(/USER_PASSWORD="([^"\n]*)"/);
      if (pwdMatch && pwdMatch[1]) {
        config.userPassword = pwdMatch[1];
      } else {
        logWarn('agent.spawn.read_parent_env', { warning: 'USER_PASSWORD is empty or missing in parent .env' });
      }
    }
  } catch (e) {
    logWarn('agent.spawn.read_parent_env', { error: e.message });
  }

  return config;
}

function buildChildRuntimeState({
  parentConfig,
  modelProvider,
  model,
  projectPath
}) {
  const inheritedConfig = normalizeRuntimeConfig(
    parentConfig.agentConfig || {},
    DEFAULT_AGENT_API_CONFIG
  );
  const parentPerms = normalizeAllowedPermissions(parentConfig.allowedPermissions || {});
  const permissionProviders = Object.keys(parentPerms).filter(
    key => key !== 'inter_agent' && key !== 'project_path'
  );

  let childProviderForConfig = modelProvider
    || inheritedConfig.model_provider
    || permissionProviders[0]
    || 'claude';

  if (permissionProviders.length > 0 && !permissionProviders.includes(childProviderForConfig)) {
    logWarn('agent.spawn.provider_fallback', {
      requestedProvider: childProviderForConfig,
      fallbackProvider: permissionProviders[0],
      reason: 'requested provider not present in inherited allowed permissions'
    });
    childProviderForConfig = permissionProviders[0];
  }

  const permissions = normalizeAllowedPermissions(parentPerms);
  permissions.inter_agent = {
    enabled: true,
    mode: 'listen_all',
    groups: [],
    ...(permissions.inter_agent || {})
  };

  const providerKeys = Object.keys(permissions).filter(
    key => key !== 'inter_agent' && key !== 'project_path'
  );
  if (providerKeys.length === 0) {
    // Grant ALL providers so the child can switch between them from the frontend,
    // matching the same provider options the parent agent would have.
    const defaults = buildDefaultLocalAgentAllowedPermissions();
    for (const [provider, perms] of Object.entries(defaults)) {
      permissions[provider] = perms;
    }
  }

  const effectiveSandbox = clampSandboxToPermissionCeiling(
    childProviderForConfig,
    inheritedConfig.sandbox_mode || DEFAULT_AGENT_API_CONFIG.sandbox_mode,
    permissions
  );

  const resolvedProjectPath = projectPath
    || inheritedConfig.project_path
    || null;
  const agentConfig = normalizeRuntimeConfig({
    ...inheritedConfig,
    model_provider: childProviderForConfig,
    model: model || inheritedConfig.model || 'default',
    approval_mode: inheritedConfig.approval_mode || 'full-auto',
    sandbox_mode: effectiveSandbox,
    project_path: resolvedProjectPath,
    updated_at: new Date().toISOString()
  }, DEFAULT_AGENT_API_CONFIG);

  return {
    agentConfig,
    allowedPermissions: permissions,
    projectPath: resolvedProjectPath
  };
}

/**
 * Create the child agent's chatspace folder with all required state files.
 */
async function initializeChildFolder({
  childAgentName,
  childAgentId,
  parentAgentId,
  childDepth,
  initialInstructions,
  parentConfig,
  modelProvider,
  model,
  projectPath,
  userCredentials  // { apiKey, encryptionSalt, apiBase, userPassword }
}) {
  const folderName = sanitizeFolderName(childAgentName);
  const chatspaceRoot = getChatspaceRoot();
  const agentDir = path.join(chatspaceRoot, folderName);
  const stateDir = path.join(agentDir, 'agent_state');

  // Create directories
  fs.mkdirSync(stateDir, { recursive: true });

  // ── agent_config.json ─────────────────────────────────────────────────
  const inheritedConfig = parentConfig.agentConfig || {};
  const parentPerms = parentConfig.allowedPermissions || {};
  const permissionProviders = Object.keys(parentPerms).filter(
    k => k !== 'inter_agent' && k !== 'project_path'
  );
  // Only honor an explicit projectPath from the caller, or one inherited from
  // the parent's agent_config.json. Do NOT fall back to the SERVER's project
  // root — the spawned child runs on the user's machine, and writing the
  // server path here would cause `cd "$PROJECT_ROOT"` in agent-runner.sh to
  // fail with "No such file or directory" on the user's box. Leaving the
  // field as null lets the local agent-runner use its own SCRIPT_DIR-based
  // default instead.
  const resolvedProjectPath = projectPath
    || inheritedConfig.project_path
    || null;
  let childProviderForConfig = modelProvider || inheritedConfig.model_provider || permissionProviders[0] || 'claude';
  if (permissionProviders.length > 0 && !permissionProviders.includes(childProviderForConfig)) {
    logWarn('agent.spawn.provider_fallback', {
      requestedProvider: childProviderForConfig,
      fallbackProvider: permissionProviders[0],
      reason: 'requested provider not present in inherited allowed permissions'
    });
    childProviderForConfig = permissionProviders[0];
  }

  // ── allowed_permissions.json ──────────────────────────────────────────
  // Inherit parent permissions ceiling, ensure inter-agent is enabled
  const permissions = JSON.parse(JSON.stringify(parentConfig.allowedPermissions || {}));
  permissions.inter_agent = {
    enabled: true,
    mode: 'listen_all',
    groups: [],
    ...(permissions.inter_agent || {})
  };

  // Ensure the child's configured provider is allowed.
  // Without this, validate_config() sees a non-empty permissions object
  // (due to inter_agent) but no provider keys, and rejects the provider.
  const providerKeys = Object.keys(permissions).filter(
    k => k !== 'inter_agent' && k !== 'project_path'
  );
  if (providerKeys.length === 0) {
    // No providers inherited — grant ALL providers so the child can switch between
    // them from the frontend, matching the same provider options the parent has.
    const defaults = buildDefaultLocalAgentAllowedPermissions();
    for (const [provider, perms] of Object.entries(defaults)) {
      permissions[provider] = perms;
    }
  }

  // Determine a sandbox_mode compatible with the permissions ceiling: keep
  // 'none' only when the ceiling explicitly allows unsandboxed operation,
  // otherwise clamp to the most permissive allowed sandbox so validate_config
  // in agent-runner.sh accepts the config.
  const effectiveSandbox = clampSandboxToPermissionCeiling(
    childProviderForConfig,
    inheritedConfig.sandbox_mode || DEFAULT_AGENT_API_CONFIG.sandbox_mode,
    permissions
  );

  const agentConfig = {
    model_provider: childProviderForConfig,
    model: model || inheritedConfig.model || 'default',
    approval_mode: inheritedConfig.approval_mode || 'full-auto',
    sandbox_mode: effectiveSandbox,
    project_path: resolvedProjectPath,
    updated_at: new Date().toISOString()
  };
  fs.writeFileSync(
    path.join(stateDir, 'agent_config.json'),
    JSON.stringify(agentConfig, null, 2)
  );

  fs.writeFileSync(
    path.join(stateDir, 'allowed_permissions.json'),
    JSON.stringify(permissions, null, 2)
  );

  // ── lineage.json ──────────────────────────────────────────────────────
  // Resolve root agent (walk up iteratively)
  let rootAgentId = parentAgentId;
  try {
    let currentId = parentAgentId;
    const seen = new Set();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const parentRow = await query(
        'SELECT agent_id, parent_agent_id, spawn_depth FROM agents WHERE agent_id = $1',
        [currentId]
      );
      if (parentRow.rows.length === 0) break;
      if (!parentRow.rows[0].parent_agent_id || parentRow.rows[0].spawn_depth === 0) {
        rootAgentId = parentRow.rows[0].agent_id;
        break;
      }
      currentId = parentRow.rows[0].parent_agent_id;
    }
  } catch (e) {
    logWarn('agent.spawn.resolve_root', { error: e.message });
  }

  const lineage = {
    agent_id: childAgentId,
    parent_agent_id: parentAgentId,
    root_agent_id: rootAgentId,
    spawn_depth: childDepth,
    auto_spawned: true,
    spawned_at: new Date().toISOString()
  };
  fs.writeFileSync(
    path.join(stateDir, 'lineage.json'),
    JSON.stringify(lineage, null, 2)
  );

  // ── conversation_history.json ─────────────────────────────────────────
  fs.writeFileSync(
    path.join(stateDir, 'conversation_history.json'),
    JSON.stringify({ sessions: [], session_count: 0, lastUpdated: new Date().toISOString() }, null, 2)
  );

  // ── agent_summary.md ──────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(stateDir, 'agent_summary.md'),
    `# ${childAgentName}\n\nSpawned agent (depth ${childDepth}).\nParent: ${parentAgentId}\n`
  );

  // ── AGENT_INSTRUCTIONS.md ─────────────────────────────────────────────
  // Use the full generated instructions (same as CLI-created agents) so the
  // spawned child knows about all available commands including spawn, DMs, etc.
  let fullInstructions = generateAgentInstructions();

  // Prepend spawn-specific context and the parent's initial instructions
  const spawnHeader = `# Agent: ${childAgentName}

> **Auto-spawned agent** (depth ${childDepth}) — created by parent agent.

## Your Mission / Initial Instructions

${initialInstructions || '_No specific instructions provided. Ask the user or your parent agent what to do._'}

---

`;

  // Append inter-agent communication section (always enabled for spawned agents)
  const interAgentSection = `

## Inter-Agent Communication

You can communicate with other agents on this account using the message_helper.py tool:

### Discover Other Agents
\`\`\`bash
uv run message_helper.py discover          # List all agents you can talk to
uv run message_helper.py discover --online # List only online agents
\`\`\`

### Send Direct Messages to Other Agents
\`\`\`bash
uv run message_helper.py dm "AgentName" "Hello, can you help with this task?"
uv run message_helper.py dm "AgentName" "Urgent request!" --priority 2
\`\`\`

### Check for Messages from Other Agents
\`\`\`bash
uv run message_helper.py dm check                    # Check all agent messages
uv run message_helper.py dm check --from "AgentName" # From specific agent
\`\`\`

### Best Practices
- Use \`discover\` first to see which agents are available
- Check for agent messages periodically during long tasks
- Coordinate with other agents on complex multi-step tasks
- Use priority 2 for urgent coordination requests
`;

  const instructions = spawnHeader + fullInstructions + interAgentSection;
  fs.writeFileSync(
    path.join(agentDir, 'AGENT_INSTRUCTIONS.md'),
    instructions
  );

  // ── .env (credentials for runner) ──────────────────────────────────────
  if (userCredentials && userCredentials.apiKey) {
    // Use the real user password so the child agent can decrypt messages.
    // The parent forwards its password via the spawn API payload.
    const childPassword = userCredentials.userPassword || '';
    if (!childPassword) {
      logWarn('agent.spawn.env_password', {
        childAgentName,
        warning: 'No user password available for child .env — message decryption will fail'
      });
    }
    const envContent = [
      '# Agent Messaging Environment Configuration',
      '# KEEP THIS FILE SECURE - DO NOT SHARE WITH AGENT',
      `USER_PASSWORD="${childPassword}"`,
      `ENCRYPTION_SALT="${userCredentials.encryptionSalt || ''}"`,
      `API_KEY="${userCredentials.apiKey}"`,
      `API_BASE="${userCredentials.apiBase || 'http://localhost:3000/api'}"`,
      `AGENT_NAME="${childAgentName}"`
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(agentDir, '.env'), envContent, { mode: 0o600 });
  }

  // ── agent-runner.sh ───────────────────────────────────────────────────
  try {
    const runnerContent = generateAgentRunner();
    fs.writeFileSync(path.join(agentDir, 'agent-runner.sh'), runnerContent, { mode: 0o755 });
  } catch (e) {
    logWarn('agent.spawn.write_runner', { error: e.message });
  }

  // ── message_helper.py ─────────────────────────────────────────────────
  try {
    // Encryption is mandatory — always generate the encrypted variant
    const helperContent = generateMessageHelperPython(true);
    fs.writeFileSync(path.join(agentDir, 'message_helper.py'), helperContent);
  } catch (e) {
    logWarn('agent.spawn.write_message_helper', { error: e.message });
  }

  // ── ONESHOT_AGENT_INSTRUCTIONS.md ─────────────────────────────────────
  try {
    const oneshotContent = generateOneshotInstructions();
    fs.writeFileSync(path.join(agentDir, 'ONESHOT_AGENT_INSTRUCTIONS.md'), oneshotContent);
  } catch (e) {
    logWarn('agent.spawn.write_oneshot_instructions', { error: e.message });
  }

  // ── SKILL_RICH_FORMS.md ───────────────────────────────────────────────
  try {
    const richFormContent = generateRichFormSkill();
    fs.writeFileSync(path.join(agentDir, 'SKILL_RICH_FORMS.md'), richFormContent);
  } catch (e) {
    logWarn('agent.spawn.write_rich_forms', { error: e.message });
  }

  // ── .gitignore ────────────────────────────────────────────────────────
  const gitignoreContent = '.env\nagent_state/.agent_response.txt\nagent_state/.stop_requested\n';
  fs.writeFileSync(path.join(agentDir, '.gitignore'), gitignoreContent);

  // ── Scheduled tasks + history init ────────────────────────────────────
  const scheduledPath = path.join(stateDir, '.scheduled_tasks.json');
  if (!fs.existsSync(scheduledPath)) {
    fs.writeFileSync(scheduledPath, '[]');
  }

  logInfo('agent.spawn.folder_created', { folder: agentDir, childAgentId });
  return {
    agentDir,
    stateDir,
    projectPath: resolvedProjectPath
  };
}

// ─── Background Agent Loop Launch ───────────────────────────────────────────

/**
 * Launch the agent-runner.sh as a detached background process.
 * The process is fully independent — it won't block the server or die when
 * the server restarts (stdio is redirected to log files, process is unref'd).
 *
 * @param {string} agentName – the child agent's display name
 * @returns {{ pid: number|null, logFile: string }} – PID and log path
 */
function launchAgentLoop(agentName) {
  const folderName = sanitizeFolderName(agentName);
  const chatspaceRoot = getChatspaceRoot();
  const agentDir = path.join(chatspaceRoot, folderName);
  const runnerPath = path.join(agentDir, 'agent-runner.sh');

  if (!fs.existsSync(runnerPath)) {
    logWarn('agent.spawn.launch_skipped', {
      agentName,
      reason: 'agent-runner.sh not found'
    });
    return { pid: null, logFile: null };
  }

  // Create log file for the agent process
  const logFile = path.join(agentDir, 'agent_state', 'agent_loop.log');

  try {
    const out = fs.openSync(logFile, 'a');
    const err = fs.openSync(logFile, 'a');

    const child = spawn('bash', [runnerPath], {
      cwd: agentDir,
      stdio: ['ignore', out, err],
      detached: true,
      env: buildAgentLaunchEnv(process.env)
    });

    // Detach: let the child run independently of this Node process
    child.unref();

    const pid = child.pid || null;

    logInfo('agent.spawn.loop_launched', {
      agentName,
      pid,
      logFile,
      runnerPath
    });

    // Write PID file so we can track / stop the agent later
    try {
      fs.writeFileSync(
        path.join(agentDir, 'agent_state', '.agent_pid'),
        String(pid)
      );
    } catch (e) {
      logWarn('agent.spawn.pid_file', { error: e.message });
    }

    return { pid, logFile };

  } catch (e) {
    logError('agent.spawn.launch_failed', {
      agentName,
      error: e.message
    });
    return { pid: null, logFile: null };
  }
}

// ─── Self-Termination ───────────────────────────────────────────────────────

/**
 * Self-terminate an agent, archive it, and re-parent any children.
 *
 * @param {Object} params
 * @param {string} params.userId     – owner user id
 * @param {string} params.agentId    – the agent requesting termination
 * @param {string} [params.reason]   – why it's terminating
 * @param {boolean} [params.archiveMessages=true] – archive messages?
 * @returns {Promise<Object>} termination summary
 */
async function selfTerminate({ userId, agentId, reason, archiveMessages = true }) {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 1. Validate agent exists and belongs to user
    const agentResult = await client.query(
      `SELECT agent_id, agent_name, parent_agent_id, spawn_depth, auto_spawned
       FROM agents
       WHERE agent_id = $1 AND user_id = $2`,
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      throw new SpawnError('Agent not found or access denied', 'AGENT_NOT_FOUND');
    }

    const agent = agentResult.rows[0];

    // 2. Find children of this agent
    const childrenResult = await client.query(
      `SELECT agent_id, agent_name FROM agents WHERE parent_agent_id = $1`,
      [agentId]
    );

    const children = childrenResult.rows;
    let orphanAction = 'none';

    if (children.length > 0) {
      if (agent.parent_agent_id) {
        // Re-parent children to this agent's parent
        await client.query(
          `UPDATE agents
           SET parent_agent_id = $1,
               spawn_depth = spawn_depth - 1
           WHERE parent_agent_id = $2`,
          [agent.parent_agent_id, agentId]
        );
        orphanAction = 'reassigned_to_parent';
      } else {
        // Promote children to root (no parent)
        await client.query(
          `UPDATE agents
           SET parent_agent_id = NULL,
               spawn_depth = GREATEST(spawn_depth - 1, 0)
           WHERE parent_agent_id = $1`,
          [agentId]
        );
        orphanAction = 'promoted_to_root';
      }
    }

    // 3. Write stop flag to filesystem
    try {
      const folderName = sanitizeFolderName(agent.agent_name);
      const stopPath = path.join(getChatspaceRoot(), folderName, 'agent_state', '.stop_requested');
      fs.writeFileSync(stopPath, new Date().toISOString());
    } catch (e) {
      logWarn('agent.self_terminate.stop_flag', { error: e.message });
    }

    await client.query('COMMIT');

    // 4. Archive the agent (uses archiveService which has its own transaction)
    let archived = false;
    if (archiveMessages) {
      try {
        await archiveAgent(userId, agentId, reason || 'Self-terminated');
        archived = true;
      } catch (archiveErr) {
        logWarn('agent.self_terminate.archive_failed', { error: archiveErr.message });
        // If archiving fails, just delete the agent row
        await query('DELETE FROM agents WHERE agent_id = $1', [agentId]);
        archived = false;
      }
    } else {
      // Just delete — CASCADE will remove messages
      await query('DELETE FROM agents WHERE agent_id = $1', [agentId]);
    }

    logInfo('agent.self_terminate', {
      agentId,
      agentName: agent.agent_name,
      reason,
      orphanedChildren: children.length,
      orphanAction,
      archived
    });

    return {
      success: true,
      agentName: agent.agent_name,
      archived,
      orphanedChildren: children.length,
      orphanAction,
      reason
    };

  } catch (error) {
    await client.query('ROLLBACK');
    logError('agent.self_terminate_failed', { agentId, error: error.message });
    throw error;
  } finally {
    client.release();
  }
}

// ─── Lineage Queries ────────────────────────────────────────────────────────

/**
 * Get the full family tree for an agent (ancestors + descendants).
 * Uses iterative queries for broad compatibility (pg-mem doesn't support
 * recursive CTEs with table aliases).
 */
async function getLineage(agentId) {
  // ── Walk up to find ancestors ─────────────────────────────────────────
  const ancestors = [];
  let currentId = agentId;
  const visited = new Set();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const result = await query(
      'SELECT agent_id, agent_name, parent_agent_id, spawn_depth FROM agents WHERE agent_id = $1',
      [currentId]
    );
    if (result.rows.length === 0) break;
    ancestors.push(result.rows[0]);
    currentId = result.rows[0].parent_agent_id;
  }

  // Sort ancestors by spawn_depth ascending (root first)
  ancestors.sort((a, b) => a.spawn_depth - b.spawn_depth);

  // ── Walk down to find descendants (BFS) ───────────────────────────────
  const descendants = [];
  const queue = [agentId];
  const visitedDesc = new Set([agentId]);

  while (queue.length > 0) {
    const parentId = queue.shift();
    const childResult = await query(
      'SELECT agent_id, agent_name, parent_agent_id, spawn_depth FROM agents WHERE parent_agent_id = $1 ORDER BY spawn_depth ASC',
      [parentId]
    );
    for (const row of childResult.rows) {
      if (!visitedDesc.has(row.agent_id)) {
        visitedDesc.add(row.agent_id);
        descendants.push(row);
        queue.push(row.agent_id);
      }
    }
  }

  return { ancestors, descendants };
}

/**
 * Get direct children of an agent.
 */
async function getChildren(parentAgentId) {
  const result = await query(
    `SELECT agent_id, agent_name, spawn_depth, can_spawn, auto_spawned, created_at
     FROM agents
     WHERE parent_agent_id = $1
     ORDER BY created_at ASC`,
    [parentAgentId]
  );
  return result.rows;
}

// ─── Custom Error ───────────────────────────────────────────────────────────

class SpawnError extends Error {
  constructor(message, code = 'SPAWN_ERROR') {
    super(message);
    this.name = 'SpawnError';
    this.code = code;
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  spawnAgent,
  selfTerminate,
  validateSpawnRequest,
  isValidSpawnAgentName,
  getLineage,
  getChildren,
  launchAgentLoop,
  buildAgentLaunchEnv,
  resolveCliBinary,
  buildDefaultLocalAgentAllowedPermissions,
  DEFAULT_LOCAL_AGENT_ALLOWED_PERMISSIONS,
  SPAWN_LIMITS,
  SpawnError,
  // Exposed for testing
  sanitizeFolderName,
  getChatspaceRoot
};
