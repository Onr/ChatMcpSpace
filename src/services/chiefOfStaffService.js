/**
 * Chief of Staff Service
 *
 * Owns the lifecycle of the privileged Chief of Staff (CoS) agent.
 * Each user can have multiple named CoS agents. Each CoS runs as a normal local agent
 * (via agent-runner.sh) but is granted is_chief_of_staff=TRUE in the DB,
 * which unlocks the /api/agent/cos/* endpoints that mutate the user's
 * roster (spawn child, delete agent, edit instructions, list roster).
 *
 * The CoS process is launched LOCALLY by the user (typically inside a
 * tmux session they start with the bootstrap command this service
 * returns). The server never spawns tmux — it only writes files and
 * inserts the DB row.
 */

const fs = require('fs');
const path = require('path');
const { query, getClient } = require('../db/connection');
const { logInfo, logWarn } = require('../utils/logger');
const {
  generateAgentRunner,
  generateMessageHelperPython,
  generateRichFormSkill,
  generateAgentInstructions,
  generateChiefOfStaffInstructions,
  generateChiefOfStaffRosterSkill,
  generateChiefOfStaffTmuxSpawnSkill,
  generateSelfWakeGuide,
  generateLargeFileTransferSkill,
  CHIEF_OF_STAFF_DEFAULT_NAME
} = require('../utils/apiGuideGenerator');
const {
  DEFAULT_AGENT_API_CONFIG,
  normalizeRuntimeConfig,
  persistAgentRuntimeState
} = require('./agentRuntimeConfigService');
const {
  sanitizeFolderName,
  getChatspaceRoot,
  buildDefaultLocalAgentAllowedPermissions
} = require('./agentSpawnService');

const COS_AGENT_NAME = CHIEF_OF_STAFF_DEFAULT_NAME;

function normalizeChiefOfStaffName(agentName) {
  const name = typeof agentName === 'string' ? agentName.trim() : '';
  return name || COS_AGENT_NAME;
}

class ChiefOfStaffError extends Error {
  constructor(message, code = 'COS_ERROR') {
    super(message);
    this.name = 'ChiefOfStaffError';
    this.code = code;
  }
}

async function getChiefOfStaffForUser(userId, options = {}) {
  const agentName = typeof options.agentName === 'string' ? options.agentName.trim() : '';
  const params = [userId];
  let nameFilter = '';
  if (agentName) {
    params.push(agentName);
    nameFilter = ` AND agent_name = $${params.length}`;
  }
  const result = await query(
    `SELECT agent_id, agent_name, is_chief_of_staff, can_spawn,
            inter_agent_mode, created_at, last_seen_at, is_working,
            last_working_heartbeat_at
     FROM agents
     WHERE user_id = $1 AND is_chief_of_staff = TRUE${nameFilter}
     ORDER BY created_at ASC
     LIMIT 1`,
    params
  );
  return result.rows[0] || null;
}

async function listChiefsOfStaffForUser(userId) {
  const result = await query(
    `SELECT agent_id, agent_name, is_chief_of_staff, can_spawn,
            inter_agent_mode, created_at, last_seen_at, is_working,
            last_working_heartbeat_at
     FROM agents
     WHERE user_id = $1 AND is_chief_of_staff = TRUE
     ORDER BY created_at ASC`,
    [userId]
  );
  return result.rows;
}

// Used outside the request lifecycle; the middleware does its own DB check.
async function isChiefOfStaff(agentId) {
  if (!agentId) return false;
  const result = await query(
    `SELECT is_chief_of_staff FROM agents WHERE agent_id = $1`,
    [agentId]
  );
  return Boolean(result.rows[0] && result.rows[0].is_chief_of_staff);
}

/**
 * List every agent owned by `userId` with the data the CoS needs to
 * present a roster: name, type, depth, parent, heartbeat, last activity.
 *
 * Implemented as two cheap queries instead of correlated subqueries so it
 * works under pg-mem (the test harness) as well as in production.
 */
async function listRoster(userId) {
  const agentsResult = await query(
    `SELECT agent_id, agent_name, agent_type, is_chief_of_staff,
            parent_agent_id, spawn_depth, can_spawn,
            inter_agent_mode, is_working, last_working_heartbeat_at,
            last_seen_at, stop_requested_at, created_at
     FROM agents
     WHERE user_id = $1
     ORDER BY is_chief_of_staff DESC, position ASC, created_at ASC`,
    [userId]
  );
  const agents = agentsResult.rows;
  if (agents.length === 0) return [];

  const agentIds = agents.map((a) => a.agent_id);
  const placeholders = agentIds.map((_, i) => `$${i + 1}`).join(',');
  const groupPlaceholders = agentIds.map((_, i) => `$${i + 2}`).join(',');

  const [agentMsgsResult, userMsgsResult, groupsResult] = await Promise.all([
    query(
      `SELECT agent_id, MAX(created_at) AS last_agent_message_at,
              COUNT(*) FILTER (WHERE read_at IS NULL) AS unread_count
       FROM messages
       WHERE agent_id IN (${placeholders})
       GROUP BY agent_id`,
      agentIds
    ),
    query(
      `SELECT agent_id, MAX(created_at) AS last_user_message_at
       FROM user_messages
       WHERE agent_id IN (${placeholders})
       GROUP BY agent_id`,
      agentIds
    ),
    query(
      `SELECT gm.agent_id, g.group_id, g.group_name
       FROM agent_group_members gm
       JOIN agent_groups g ON g.group_id = gm.group_id
       WHERE g.user_id = $1 AND gm.agent_id IN (${groupPlaceholders})
       ORDER BY g.group_name ASC`,
      [userId, ...agentIds]
    )
  ]);

  const msgs = new Map();
  for (const row of agentMsgsResult.rows) {
    msgs.set(row.agent_id, {
      last_agent_message_at: row.last_agent_message_at,
      unread_count: Number(row.unread_count) || 0
    });
  }
  for (const row of userMsgsResult.rows) {
    const existing = msgs.get(row.agent_id) || { last_agent_message_at: null, unread_count: 0 };
    existing.last_user_message_at = row.last_user_message_at;
    msgs.set(row.agent_id, existing);
  }

  const groupsByAgent = new Map();
  for (const row of groupsResult.rows) {
    const groups = groupsByAgent.get(row.agent_id) || [];
    groups.push({ group_id: row.group_id, group_name: row.group_name });
    groupsByAgent.set(row.agent_id, groups);
  }

  return agents.map((a) => ({
    ...a,
    last_agent_message_at: msgs.get(a.agent_id)?.last_agent_message_at || null,
    last_user_message_at: msgs.get(a.agent_id)?.last_user_message_at || null,
    unread_count: msgs.get(a.agent_id)?.unread_count || 0,
    groups: groupsByAgent.get(a.agent_id) || []
  }));
}

function buildTmuxSessionName(agentName) {
  return sanitizeFolderName(normalizeChiefOfStaffName(agentName)) || 'local-chief-of-staff';
}

function buildBootstrapCommand({ agentDir, agentName }) {
  // The user pastes this in a fresh terminal on their machine.
  // It cd's into the CoS chatspace and starts the agent-runner in a
  // named, detached tmux session, then attaches so they can watch boot.
  const escapedDir = agentDir.replace(/(["\\$`])/g, '\\$1');
  const tmuxSessionName = buildTmuxSessionName(agentName);
  return [
    `cd "${escapedDir}"`,
    `tmux new-session -d -s "${tmuxSessionName}" "./agent-runner.sh"`,
    `tmux attach -t "${tmuxSessionName}"`
  ].join(' && ');
}

/**
 * Install the Chief of Staff agent for a user.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.apiKey         - the user's API key (written to .env)
 * @param {string} params.encryptionSalt - user's encryption salt (.env)
 * @param {string} [params.apiBase]      - API base URL (defaults to localhost)
 * @param {string} [params.userPassword] - decryption password (.env)
 * @param {string} [params.userName]
 * @param {string} [params.agentName]    - display name for this local CoS instance
 * @returns {Promise<{ agent, bootstrap, agentDir }>}
 */
async function installChiefOfStaff({
  userId,
  apiKey,
  encryptionSalt,
  apiBase,
  userPassword,
  userName,
  agentName,
  skipFiles = false
}) {
  if (!userId) {
    throw new ChiefOfStaffError('userId is required', 'COS_INVALID_INPUT');
  }
  if (!apiKey) {
    throw new ChiefOfStaffError('apiKey is required', 'COS_INVALID_INPUT');
  }

  const client = await getClient();
  let createdAgent;
  const resolvedAgentName = normalizeChiefOfStaffName(agentName);
  const missionText = generateChiefOfStaffInstructions({
    userName: userName || null,
    apiBase: apiBase || 'http://localhost:3000/api'
  });
  try {
    await client.query('BEGIN');

    const posResult = await client.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM agents WHERE user_id = $1`,
      [userId]
    );
    const nextPosition = posResult.rows[0].next_pos;

    const insertResult = await client.query(
      `INSERT INTO agents
         (user_id, agent_name, agent_type, position,
          is_chief_of_staff, can_spawn, inter_agent_mode,
          initial_instructions, auto_spawned, spawn_depth)
       VALUES ($1, $2, 'standard', $3,
               TRUE, TRUE, 'listen_all',
               $4, FALSE, 0)
       RETURNING agent_id, agent_name, position, created_at`,
      [userId, resolvedAgentName, nextPosition, missionText]
    );

    createdAgent = insertResult.rows[0];

    // NOTE: deliberately do NOT set project_path here. The Local Chief of Staff
    // runs on the user's own machine and its agent-runner.sh derives PROJECT_ROOT
    // from its own SCRIPT_DIR. Baking the server's project path into the stored
    // runtime_config would cause `cd "$PROJECT_ROOT"` to fail with
    // "No such file or directory" on every user machine where that path doesn't
    // exist.
    const runtimeConfig = normalizeRuntimeConfig(
      {
        ...DEFAULT_AGENT_API_CONFIG,
        approval_mode: 'full-auto',
        sandbox_mode: 'workspace-write',
        updated_at: new Date().toISOString()
      },
      DEFAULT_AGENT_API_CONFIG
    );

    const allowedPermissions = buildDefaultLocalAgentAllowedPermissions();

    await persistAgentRuntimeState({
      agentId: createdAgent.agent_id,
      config: runtimeConfig,
      allowedPermissions,
      dbClient: client
    });

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof ChiefOfStaffError) throw error;
    if (error.code === '23505') {
      const existingSameName = await getChiefOfStaffForUser(userId, {
        agentName: resolvedAgentName
      }).catch(() => null);
      if (existingSameName) {
        throw new ChiefOfStaffError(
          `A Chief of Staff named "${resolvedAgentName}" already exists for this user`,
          'COS_ALREADY_INSTALLED'
        );
      }
      throw new ChiefOfStaffError(
        `An agent named "${resolvedAgentName}" already exists — choose a different Chief of Staff name`,
        'COS_NAME_CONFLICT'
      );
    }
    logWarn('cos.install.db_failed', { userId, error: error.message });
    throw new ChiefOfStaffError(
      `Failed to install Chief of Staff: ${error.message}`,
      'COS_INSTALL_FAILED'
    );
  } finally {
    client.release();
  }

  // The bundle is always returned so a remote CLI client can write the
  // files on the user's own machine even when the server skips its local
  // write (which is only useful when the server *is* the user's machine).
  const fileBundle = buildChiefOfStaffFileBundle({
    agentName: createdAgent.agent_name,
    agentId: createdAgent.agent_id,
    initialInstructions: missionText,
    apiKey,
    encryptionSalt,
    apiBase: apiBase || 'http://localhost:3000/api',
    userPassword: userPassword || ''
  });

  let agentDir = null;
  if (!skipFiles) {
    try {
      agentDir = writeChiefOfStaffFiles({
        agentName: createdAgent.agent_name,
        agentId: createdAgent.agent_id,
        initialInstructions: missionText,
        apiKey,
        encryptionSalt,
        apiBase: apiBase || 'http://localhost:3000/api',
        userPassword: userPassword || ''
      });
    } catch (fileErr) {
      logWarn('cos.install.write_files_failed', { userId, error: fileErr.message });
      throw new ChiefOfStaffError(
        `Local Chief of Staff DB row created, but file write failed: ${fileErr.message}`,
        'COS_FILE_WRITE_FAILED'
      );
    }
  }

  const tmuxSessionName = buildTmuxSessionName(createdAgent.agent_name);
  const bootstrap = agentDir
    ? {
        command: buildBootstrapCommand({ agentDir, agentName: createdAgent.agent_name }),
        agentDir,
        tmuxSessionName,
        notes: [
          'Paste the command into a terminal on the machine where this server runs.',
          'It opens a detached tmux session and attaches so you can watch the agent boot.',
          `Detach later with Ctrl-b then d. Re-attach with: tmux attach -t ${tmuxSessionName}.`
        ]
      }
    : {
        command: null,
        agentDir: null,
        tmuxSessionName,
        notes: [
          'Server-side files were skipped at the caller\'s request.',
          'Use the fileBundle in this response (or call agent-cli.sh --local-cos) to write the agent on your own machine.'
        ]
      };

  logInfo('cos.install.success', {
    userId,
    agentId: createdAgent.agent_id,
    agentDir,
    skipFiles
  });

  // When the server wrote the files locally (skipFiles=false), the caller
  // does not need the sensitive payload echoed back. Strip credential-bearing
  // entries (.env contains API_KEY/USER_PASSWORD/ENCRYPTION_SALT) so a
  // proxy/log/anyone watching the response doesn't see them. The remote CLI
  // install path (skipFiles=true) still needs the full bundle to write the
  // files on the user's own machine, so leave it intact there.
  const responseBundle = skipFiles ? fileBundle : stripSensitiveBundleEntries(fileBundle);

  return {
    agent: {
      agentId: createdAgent.agent_id,
      agentName: createdAgent.agent_name,
      isChiefOfStaff: true,
      createdAt: createdAgent.created_at,
      position: createdAgent.position
    },
    bootstrap,
    agentDir,
    fileBundle: responseBundle
  };
}

/**
 * Return a shallow copy of the file bundle with sensitive entries omitted.
 * Used to avoid echoing credentials back over HTTP when the server already
 * wrote them to disk itself.
 */
function stripSensitiveBundleEntries(bundle) {
  if (!bundle || typeof bundle !== 'object') return bundle;
  const result = {};
  for (const [relPath, entry] of Object.entries(bundle)) {
    if (entry && entry.sensitive === true) continue;
    result[relPath] = entry;
  }
  return result;
}

/**
 * Build the complete set of files the Local Chief of Staff needs, indexed
 * by their relative path inside the agent folder. The bundle is the same
 * regardless of whether the server writes them locally or hands them to a
 * remote CLI client for the user to write on their own machine.
 *
 * Each entry has the shape:
 *   { content: string, mode?: number, sensitive?: boolean }
 */
function buildChiefOfStaffFileBundle({
  agentName,
  agentId,
  initialInstructions,
  apiKey,
  encryptionSalt,
  apiBase,
  userPassword
}) {
  // NOTE: project_path is intentionally omitted. See installChiefOfStaff above —
  // the local agent-runner.sh derives PROJECT_ROOT from its own SCRIPT_DIR so
  // the same bundle works on any user machine.
  const agentConfig = {
    model_provider: 'claude',
    model: 'default',
    approval_mode: 'full-auto',
    sandbox_mode: 'workspace-write',
    updated_at: new Date().toISOString()
  };

  const allowedPermissions = buildDefaultLocalAgentAllowedPermissions();

  const envLines = [
    '# Local Chief of Staff environment',
    '# DO NOT COMMIT — contains credentials.',
    `USER_PASSWORD="${userPassword || ''}"`,
    `ENCRYPTION_SALT="${encryptionSalt || ''}"`,
    `API_KEY="${apiKey}"`,
    `API_BASE="${apiBase}"`,
    `AGENT_NAME="${agentName}"`,
    `IS_CHIEF_OF_STAFF="true"`,
    ''
  ];

  return {
    'AGENT_INSTRUCTIONS.md': { content: initialInstructions },
    'SKILL_AGENT_ROSTER.md': { content: generateChiefOfStaffRosterSkill() },
    'SKILL_TMUX_SPAWN.md': { content: generateChiefOfStaffTmuxSpawnSkill() },
    'SKILL_RICH_FORMS.md': { content: generateRichFormSkill() },
    'SELF_WAKE_GUIDE.md': { content: generateSelfWakeGuide() },
    'SKILL_LARGE_FILE_TRANSFER.md': { content: generateLargeFileTransferSkill() },
    'agent-runner.sh': { content: generateAgentRunner(), mode: 0o755 },
    'message_helper.py': { content: generateMessageHelperPython(Boolean(encryptionSalt)) },
    'agent_state/agent_config.json': { content: JSON.stringify(agentConfig, null, 2) },
    'agent_state/allowed_permissions.json': { content: JSON.stringify(allowedPermissions, null, 2) },
    'agent_state/lineage.json': {
      content: JSON.stringify(
        {
          agent_id: agentId,
          parent_agent_id: null,
          root_agent_id: agentId,
          spawn_depth: 0,
          is_chief_of_staff: true,
          spawned_at: new Date().toISOString()
        },
        null,
        2
      )
    },
    'agent_state/conversation_history.json': {
      content: JSON.stringify(
        { sessions: [], session_count: 0, lastUpdated: new Date().toISOString() },
        null,
        2
      )
    },
    'agent_state/.scheduled_tasks.json': { content: '[]' },
    'agent_state/agent_summary.md': {
      content: `# ${agentName}\n\nLocal Chief of Staff agent.\nPrivileged role: spawns, edits, and deletes other agents on behalf of the user.\nAll spawned agents live as folders on this same local machine.\n`
    },
    'agent_state/roster.json': {
      content: JSON.stringify({ agents: [], updated_at: null }, null, 2)
    },
    '.env': { content: envLines.join('\n'), mode: 0o600, sensitive: true },
    '.gitignore': {
      content: '.env\nagent_state/.agent_response.txt\nagent_state/.stop_requested\nagent_state/.dm_pending\nagent_state/roster.json\n'
    }
  };
}

function writeChiefOfStaffFiles({
  agentName,
  agentId,
  initialInstructions,
  apiKey,
  encryptionSalt,
  apiBase,
  userPassword
}) {
  const folderName = sanitizeFolderName(agentName);
  const chatspaceRoot = getChatspaceRoot();
  const agentDir = path.join(chatspaceRoot, folderName);
  fs.mkdirSync(path.join(agentDir, 'agent_state'), { recursive: true });

  const bundle = buildChiefOfStaffFileBundle({
    agentName,
    agentId,
    initialInstructions,
    apiKey,
    encryptionSalt,
    apiBase,
    userPassword
  });

  for (const [relPath, entry] of Object.entries(bundle)) {
    const fullPath = path.join(agentDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const opts = {};
    if (typeof entry.mode === 'number') opts.mode = entry.mode;
    fs.writeFileSync(fullPath, entry.content, opts);
  }

  return agentDir;
}

function writeChildAgentFiles({
  agentName,
  agentId,
  initialInstructions,
  credentials,
  runtimeConfig = null,
  allowedPermissions = null
}) {
  const folderName = sanitizeFolderName(agentName);
  const chatspaceRoot = getChatspaceRoot();
  const agentDir = path.join(chatspaceRoot, folderName);
  const stateDir = path.join(agentDir, 'agent_state');
  fs.mkdirSync(stateDir, { recursive: true });

  const header = `# Agent: ${agentName}

> **Spawned by your Local Chief of Staff.** Your mission is below; talk to
> the CoS for help or escalation. The user can also message you directly.

## Your Mission

${initialInstructions || '_No mission specified — DM the Chief of Staff for guidance._'}

---

`;
  fs.writeFileSync(
    path.join(agentDir, 'AGENT_INSTRUCTIONS.md'),
    header + generateAgentInstructions()
  );

  fs.writeFileSync(
    path.join(agentDir, 'SKILL_RICH_FORMS.md'),
    generateRichFormSkill()
  );

  fs.writeFileSync(
    path.join(agentDir, 'agent-runner.sh'),
    generateAgentRunner(),
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(agentDir, 'message_helper.py'),
    generateMessageHelperPython(Boolean(credentials && credentials.encryptionSalt))
  );

  // NOTE: when no runtimeConfig is supplied we deliberately omit project_path —
  // the local agent-runner.sh derives PROJECT_ROOT from its own SCRIPT_DIR so the
  // same bundle works on any user machine. Callers that DO know the user's local
  // path (e.g. spawnAgent on the user's CoS) may pass it through runtimeConfig.
  const agentConfig = normalizeRuntimeConfig(
    runtimeConfig || {
      model_provider: 'claude',
      model: 'default',
      approval_mode: 'full-auto',
      sandbox_mode: 'workspace-write',
      updated_at: new Date().toISOString()
    },
    DEFAULT_AGENT_API_CONFIG
  );
  // A CoS-created child gets a self-contained working directory by default.
  // An explicit project_path remains an intentional override.
  if (!agentConfig.project_path) {
    agentConfig.project_path = agentDir;
  }
  fs.writeFileSync(
    path.join(stateDir, 'agent_config.json'),
    JSON.stringify(agentConfig, null, 2)
  );

  fs.writeFileSync(
    path.join(stateDir, 'allowed_permissions.json'),
    JSON.stringify(
      allowedPermissions || buildDefaultLocalAgentAllowedPermissions(),
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(stateDir, 'conversation_history.json'),
    JSON.stringify({ sessions: [], session_count: 0, lastUpdated: new Date().toISOString() }, null, 2)
  );

  fs.writeFileSync(
    path.join(stateDir, '.scheduled_tasks.json'),
    '[]'
  );

  fs.writeFileSync(
    path.join(stateDir, 'agent_summary.md'),
    `# ${agentName}\n\nSpawned by your Local Chief of Staff.\n`
  );

  const memoryDir = path.join(agentDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, 'MEMORY.md'),
    `# ${agentName} memory\n\nKeep durable task context, decisions, and handoffs here.\n`
  );

  if (credentials && credentials.apiKey) {
    const envLines = [
      '# Agent environment — DO NOT COMMIT',
      `USER_PASSWORD="${credentials.userPassword || ''}"`,
      `ENCRYPTION_SALT="${credentials.encryptionSalt || ''}"`,
      `API_KEY="${credentials.apiKey}"`,
      `API_BASE="${credentials.apiBase || 'http://localhost:3000/api'}"`,
      `AGENT_NAME="${agentName}"`,
      ''
    ];
    fs.writeFileSync(path.join(agentDir, '.env'), envLines.join('\n'), { mode: 0o600 });
  }

  fs.writeFileSync(
    path.join(agentDir, '.gitignore'),
    '.env\nagent_state/.agent_response.txt\nagent_state/.stop_requested\nagent_state/.dm_pending\n'
  );

  return agentDir;
}

module.exports = {
  installChiefOfStaff,
  getChiefOfStaffForUser,
  isChiefOfStaff,
  listRoster,
  listChiefsOfStaffForUser,
  writeChiefOfStaffFiles,
  buildChiefOfStaffFileBundle,
  writeChildAgentFiles,
  buildBootstrapCommand,
  buildTmuxSessionName,
  COS_AGENT_NAME,
  normalizeChiefOfStaffName,
  ChiefOfStaffError
};
