/**
 * User API Routes
 * AJAX endpoints for frontend polling and user interactions
 */

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const path = require('path');

// Simple mutex for serializing feedback CSV writes to prevent race conditions
const feedbackWriteMutex = {
  locked: false,
  queue: [],
  async acquire() {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  },
  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.locked = false;
    }
  }
};
const MAX_FEEDBACK_IMAGE_BYTES = 5 * 1_000_000;
const FEEDBACK_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const feedbackImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FEEDBACK_IMAGE_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, FEEDBACK_IMAGE_TYPES.has(String(file.mimetype || '').toLowerCase()))
});

function parseFeedbackImage(req, res, next) {
  feedbackImageUpload.single('image')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return validationError(res, 'Feedback image must be 5MB or smaller');
    }
    return validationError(res, 'Attach one PNG, JPEG, WebP, or GIF image only');
  });
}
const router = express.Router();
const { attachUserFromSession } = require('../middleware/authMiddleware');
const {
  userPollingRateLimiter,
  feedbackRateLimiter,
  agentApiRateLimiter,
  agentPollingRateLimiter,
  agentMessageIngressRateLimiter,
  getUsageStatus,
  resolveClientIdentifier
} = require('../middleware/rateLimitMiddleware');
const { query, getClient } = require('../db/connection');
const { validateTimestamp, isValidUUID, formatTimestampForDatabase, validateMessageContent, validateAttachmentIds } = require('../utils/validation');
const { validationError, forbiddenError, handleDatabaseError, internalError } = require('../utils/errorHandler');
const { logUnauthorizedAccess } = require('../utils/securityLogger');

const SHOULD_USE_TEST_DB_BULK_FALLBACK = process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;
const ttsService = require('../services/ttsService');
const { uploadAttachment, downloadAttachment } = require('../controllers/userAttachmentController');
const archiveService = require('../services/archiveService');
const { createArchiveAwareQuery } = require('../utils/archiveQueryWrapper');
const { sanitizeFolderName, getChatspaceRoot } = require('../services/agentSpawnService');
const { issueScopedCredential, revokeActiveCredentials } = require('../services/agentCredentialService');
const { AGENT_CLI_VERSION, isCliVersionOutdated } = require('../utils/agentCliVersion');
const { readPidFromFile, terminateProcessWithEscalation } = require('../utils/agentStopUtils');
const { loadAgentRuntimeState } = require('../services/agentRuntimeConfigService');
const { validateRunOverrides } = require('../utils/runOverrides');
const chatThreadService = require('../shared/chatThreadService');

async function resolveRunOverrides(agentId, agentName, input) {
  if (input === undefined || input === null) return { valid: true, value: null };
  const { allowedPermissions } = await loadAgentRuntimeState({ agentId, agentName });
  return validateRunOverrides(input, allowedPermissions);
}

const OPENCLAW_FEATURE_FLAG = process.env.FEATURE_OPENCLAW_EXTERNAL_BOTS !== 'false';
const VALID_INTER_AGENT_MODES = new Set(['disabled', 'listen_all', 'groups']);
const VALID_EXTERNAL_AGENT_PROVIDERS = new Set(['openclaw', 'hermes', 'custom']);
const AGENT_WORKING_HEARTBEAT_MAX_AGE_MS = 30_000;
const USER_MESSAGE_DELIVERY_TIMEOUT_MS = 2 * 60 * 1000;
const EXTERNAL_AGENT_PAIRING_TTL_MS = 10 * 60 * 1000;

function normalizeExternalAgentProvider(provider) {
  const normalized = String(provider || 'custom').trim().toLowerCase();
  if (VALID_EXTERNAL_AGENT_PROVIDERS.has(normalized)) return normalized;
  if (/^[a-z0-9_-]{1,50}$/.test(normalized)) return normalized;
  return null;
}

function generateExternalAgentPairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < bytes.length; i += 1) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function hashExternalAgentPairingCode(pairingCode) {
  return crypto
    .createHash('sha256')
    .update(String(pairingCode || '').trim().toUpperCase())
    .digest('hex');
}

function normalizeGroupNames(groupNames) {
  if (!Array.isArray(groupNames)) return null;
  return groupNames
    .map((groupName) => String(groupName || '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

function getPollAdvice(req, hadPayload = false) {
  const advice = req.res && req.res.locals ? req.res.locals.pollAdvice : null;
  if (!advice) return undefined;
  return {
    ...advice,
    reason: hadPayload ? 'payload' : advice.reason
  };
}

/**
 * Find agent directory on local filesystem by searching multiple locations.
 */
function findAgentLocalDir(agentFolder) {
  const searchPaths = [
    path.join(process.cwd(), '.chatspace', agentFolder),
    path.join(process.env.HOME || '', '.chatspace', agentFolder),
    path.join(process.cwd(), 'chatspace', agentFolder),
    path.join(process.env.HOME || '', 'chatspace', agentFolder),
  ];
  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getPrimaryLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    if (!Array.isArray(addresses)) continue;
    for (const address of addresses) {
      if (!address || address.internal) continue;
      if (address.family === 'IPv4' || address.family === 4) {
        return address.address;
      }
    }
  }
  return null;
}

function isMissingColumnError(error, columnName) {
  if (!error || !columnName) return false;
  const haystack = `${error.message || ''} ${error.detail || ''} ${error.code || ''} ${error?.data?.error || ''}`.toLowerCase();
  return (error.code === '42703' || haystack.includes('column')) && haystack.includes(columnName.toLowerCase());
}

function getDefaultScopedScopes({ canSpawn }) {
  const scopes = [
    'agent.messages.write',
    'agent.questions.write',
    'agent.responses.read',
    'agent.discover.read',
    'agent.dm.write',
    'agent.dm.read',
    'agent.groups.read',
    'agent.groups.write',
    'agent.stop.write',
    'agent.lineage.read',
    'agent.attachments.read',
    'agent.attachments.write',
    'agent.history.read'
  ];

  if (canSpawn === true) {
    scopes.push('agent.spawn.write');
  }

  return scopes;
}

function buildOpenClawBootstrap({ agentName, token, apiBase, webBase, canSpawn }) {
  const spawnSnippet = canSpawn
    ? 'POST /api/agent/spawn (enabled for this bot)'
    : 'Spawn is disabled by default for this bot.';
  const normalizedWebBase = (webBase || '').replace(/\/+$/, '');
  const hostedSetupCommand = `curl -sL ${normalizedWebBase}/setup | bash`;
  const localSetupCommand = 'curl -sL https://chatmcp.space/setup | bash';
  return `# OpenClaw Bootstrap for ${agentName}

Use this platform as your control plane and messaging backbone.

User handoff phrase:
- "Try to connect to my council at chatmcp.space, please set it up."

Self-setup workflow:
1. Open ${normalizedWebBase}/setup and read the setup instructions shown there.
2. If running against the local panel, run:
   ${localSetupCommand}
3. If running against hosted panel, run:
   ${hostedSetupCommand}
4. Prompt the user for their API key when the installer asks for it.
5. If the user does not have an account yet:
   - Guide them to create one at ${normalizedWebBase}/register
   - Ask them to sign in at ${normalizedWebBase}/login
   - Ask them to open ${normalizedWebBase}/settings and copy their API key
6. If user asks for password help:
   - Ask for account password only for login/registration steps
   - Never store or echo the password in logs/files
7. After setup script finishes, run:
   bash agent-cli.sh
8. Continue with API handshake and council messaging using the scoped token below.

Authentication:
- Header: X-Agent-Token: ${token}
- Header: X-Agent-Name: ${agentName}
- Base URL: ${apiBase}

Core operations:
- Send update to user: POST /api/agent/messages
- Ask question: POST /api/agent/questions
- Poll user replies: GET /api/agent/responses
- Discover agents: GET /api/agent/discover
- Send DM to agent: POST /api/agent/messages/direct
- Poll DMs: GET /api/agent/messages/direct
- Manage groups: GET/POST /api/agent/groups
- ${spawnSnippet}
- Stop/self-terminate: POST /api/agent/stop or /api/agent/self-terminate
- Lineage: GET /api/agent/lineage
`;
}

async function syncAgentGroups(client, userId, agentId, groupNames) {
  await client.query('DELETE FROM agent_group_members WHERE agent_id = $1', [agentId]);

  for (const rawGroupName of groupNames) {
    const groupName = String(rawGroupName || '').trim();
    if (!groupName) continue;

    const existing = await client.query(
      'SELECT group_id FROM agent_groups WHERE user_id = $1 AND group_name = $2',
      [userId, groupName]
    );

    let groupId = null;
    if (existing.rows.length > 0) {
      groupId = existing.rows[0].group_id;
    } else {
      const created = await client.query(
        'INSERT INTO agent_groups (user_id, group_name) VALUES ($1, $2) RETURNING group_id',
        [userId, groupName]
      );
      groupId = created.rows[0].group_id;
    }

    await client.query(
      'INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, agentId]
    );
  }
}

/**
 * Build short notification text for voice announcements
 */
function buildNotificationText(agentName, messageType, priority, urgent) {
  const name = agentName || 'your agent';

  if (urgent) {
    return `Received urgent message from ${name}.`;
  }

  if (priority === 2 || priority === 'high') {
    return `Received high priority message from ${name}.`;
  }

  if (messageType === 'agent_question') {
    return `Question from ${name}.`;
  }

  return `Update from ${name}.`;
}

let messageSchemaCapabilitiesCache = {
  expiresAt: 0,
  value: null
};

async function getMessageSchemaCapabilities() {
  const now = Date.now();
  const useSchemaCache = process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID;
  if (useSchemaCache && messageSchemaCapabilitiesCache.value && messageSchemaCapabilitiesCache.expiresAt > now) {
    return messageSchemaCapabilitiesCache.value;
  }

  try {
    const result = await query(`
      SELECT
        MAX(CASE
          WHEN table_name = 'messages' AND column_name = 'hidden_from_agent' THEN 1
          ELSE 0
        END) AS has_messages_hidden_from_agent,
        MAX(CASE
          WHEN table_name = 'messages' AND column_name = 'run_command' THEN 1
          ELSE 0
        END) AS has_messages_run_command,
        MAX(CASE
          WHEN table_name = 'user_messages' AND column_name = 'hidden_from_agent' THEN 1
          ELSE 0
        END) AS has_user_messages_hidden_from_agent
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'messages' AND column_name IN ('hidden_from_agent', 'run_command'))
          OR (table_name = 'user_messages' AND column_name = 'hidden_from_agent')
        )
    `);

    const value = {
      hasMessagesHiddenFromAgent: Number(result.rows[0]?.has_messages_hidden_from_agent || 0) === 1,
      hasMessagesRunCommand: Number(result.rows[0]?.has_messages_run_command || 0) === 1,
      hasUserMessagesHiddenFromAgent: Number(result.rows[0]?.has_user_messages_hidden_from_agent || 0) === 1
    };

    // pg-mem's information_schema support is incomplete in a few route tests. Keep
    // the production path schema-driven, but preserve test coverage for the
    // run_command projection by letting the query-level fallback handle older test
    // schemas.
    if (!useSchemaCache) {
      value.hasMessagesRunCommand = true;
    }

    if (!value.hasMessagesHiddenFromAgent || !value.hasMessagesRunCommand || !value.hasUserMessagesHiddenFromAgent) {
      const probeColumn = async (probeQuery) => {
        try {
          await query(probeQuery);
          return true;
        } catch (_error) {
          return false;
        }
      };

      if (!value.hasMessagesHiddenFromAgent) {
        value.hasMessagesHiddenFromAgent = await probeColumn('SELECT hidden_from_agent FROM messages LIMIT 1');
      }
      if (!value.hasMessagesRunCommand) {
        value.hasMessagesRunCommand = await probeColumn('SELECT run_command FROM messages LIMIT 1');
      }
      if (!value.hasUserMessagesHiddenFromAgent) {
        value.hasUserMessagesHiddenFromAgent = await probeColumn('SELECT hidden_from_agent FROM user_messages LIMIT 1');
      }
    }

    // Cache briefly to reduce schema introspection overhead on high-frequency polling.
    messageSchemaCapabilitiesCache = {
      value,
      expiresAt: useSchemaCache ? now + 60_000 : 0
    };
    return value;
  } catch (_error) {
    // Safe fallback for older/limited DB schemas.
    const value = {
      hasMessagesHiddenFromAgent: false,
      hasMessagesRunCommand: !useSchemaCache,
      hasUserMessagesHiddenFromAgent: false
    };
    messageSchemaCapabilitiesCache = {
      value,
      expiresAt: useSchemaCache ? now + 5_000 : 0
    };
    return value;
  }
}

function isAgentCurrentlyWorking(isWorking, lastWorkingHeartbeatAt, nowMs = Date.now()) {
  if (isWorking !== true || !lastWorkingHeartbeatAt) {
    return false;
  }

  const heartbeatMs = new Date(lastWorkingHeartbeatAt).getTime();
  if (!Number.isFinite(heartbeatMs)) {
    return false;
  }

  return (nowMs - heartbeatMs) <= AGENT_WORKING_HEARTBEAT_MAX_AGE_MS;
}

function buildUserMessageDeliveryState({ readAt, createdAt, hiddenFromAgent, agentIsWorking, agentLastWorkingHeartbeatAt }, nowMs = Date.now()) {
  if (readAt) {
    return {
      deliveryState: 'read',
      deliveryFailed: false,
      isAgentWorking: isAgentCurrentlyWorking(agentIsWorking, agentLastWorkingHeartbeatAt, nowMs),
      failedReason: null
    };
  }

  const createdAtMs = createdAt ? new Date(createdAt).getTime() : Number.NaN;
  const timedOut = Number.isFinite(createdAtMs) && (nowMs - createdAtMs) >= USER_MESSAGE_DELIVERY_TIMEOUT_MS;
  const isWorking = isAgentCurrentlyWorking(agentIsWorking, agentLastWorkingHeartbeatAt, nowMs);
  const deliveryFailed = hiddenFromAgent !== true && timedOut && !isWorking;

  return {
    deliveryState: deliveryFailed ? 'failed' : 'pending',
    deliveryFailed,
    isAgentWorking: isWorking,
    failedReason: deliveryFailed ? 'agent_not_receiving' : null
  };
}

function formatUserMessageStatusRow(row, messageId) {
  const delivery = buildUserMessageDeliveryState({
    readAt: row.read_at,
    createdAt: row.created_at,
    hiddenFromAgent: row.hidden_from_agent === true,
    agentIsWorking: row.is_working === true,
    agentLastWorkingHeartbeatAt: row.last_working_heartbeat_at
  });

  return {
    messageId,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    deliveryState: delivery.deliveryState,
    deliveryFailed: delivery.deliveryFailed,
    failedReason: delivery.failedReason
  };
}

async function fetchUserMessageStatusRows(agentId, messageIds) {
  const placeholders = messageIds.map((_, index) => `$${index + 2}`).join(', ');
  const params = [agentId, ...messageIds];

  try {
    return await query(
      `SELECT
         um.user_message_id,
         um.read_at,
         um.created_at,
         um.hidden_from_agent,
         a.is_working,
         a.last_working_heartbeat_at
       FROM user_messages um
       JOIN agents a ON a.agent_id = um.agent_id
       WHERE um.agent_id = $1 AND um.user_message_id IN (${placeholders})`,
      params
    );
  } catch (statusError) {
    if (statusError.code !== '42703') {
      throw statusError;
    }

    // Backward compatibility: older schemas may not have user_messages.hidden_from_agent.
    return query(
      `SELECT
         um.user_message_id,
         um.read_at,
         um.created_at,
         FALSE AS hidden_from_agent,
         a.is_working,
         a.last_working_heartbeat_at
       FROM user_messages um
       JOIN agents a ON a.agent_id = um.agent_id
       WHERE um.agent_id = $1 AND um.user_message_id IN (${placeholders})`,
      params
    );
  }
}

/**
 * Generate a TTS audio URL using server-side Google Cloud TTS with caching
 */
async function buildNotificationAudioUrl(text) {
  if (!text) {
    return null;
  }

  try {
    return await ttsService.getAudioUrl(text);
  } catch (error) {
    console.warn('Failed to generate TTS URL', error);
    return null;
  }
}

// Apply session authentication to all user API routes
router.use(attachUserFromSession);

// Apply rate limiting to all user API routes (generous for dashboard UI)
router.use(userPollingRateLimiter);
router.use('/chat-threads', require('../shared/chatThreadRoutes'));
router.use('/shared', require('../shared/routes').users);

// ─── Chief of Staff install ────────────────────────────────────────────────
const chiefOfStaffService = require('../services/chiefOfStaffService');

/**
 * Commands the install modal shows so a user can put the Chief of Staff on
 * their OWN computer: download the CLI, then run its --local-cos action.
 *
 * The base URL is resolved the same way GET /setup resolves it
 * (see pageRoutes.js) so the command always points at the server the browser
 * is actually talking to.
 *
 * Both commands run in the same folder on purpose. agent-cli.sh derives
 * CHATSPACE_DIR from its own location ("$SCRIPT_DIR/.chatspace"), so the
 * folder the user runs the installer in becomes the home for the Chief of
 * Staff and every agent it spawns. `/setup` also drops a copy in ~/.chatmcp/,
 * but invoking that copy would bury the agents in a hidden directory.
 */
function buildChiefOfStaffSetupCommands(req) {
  const webBase = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`)
    .replace(/\/+$/, '');
  return {
    setupCommand: `curl -sL ${webBase}/setup | bash`,
    localCosCommand: 'bash agent-cli.sh --local-cos',
    apiKeyUrl: `${webBase}/settings`
  };
}

/**
 * GET /api/user/install-chief-of-staff/status
 * Returns whether the user already has a Chief of Staff installed, plus the
 * terminal commands for installing one on the user's own machine.
 */
router.get('/install-chief-of-staff/status', async (req, res) => {
  try {
    const setup = buildChiefOfStaffSetupCommands(req);
    const agents = await chiefOfStaffService.listChiefsOfStaffForUser(req.user.userId);
    if (agents.length === 0) {
      return res.json({ installed: false, setup });
    }
    const agent = agents[0];
    res.json({
      installed: true,
      setup,
      installed_at: agent.created_at,
      count: agents.length,
      agent: {
        agentId: agent.agent_id,
        agentName: agent.agent_name,
        isWorking: agent.is_working,
        lastWorkingHeartbeatAt: agent.last_working_heartbeat_at
      },
      agents: agents.map((row) => ({
        agentId: row.agent_id,
        agentName: row.agent_name,
        isWorking: row.is_working,
        lastWorkingHeartbeatAt: row.last_working_heartbeat_at,
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    handleDatabaseError(res, error, 'cos status');
  }
});

/**
 * POST /api/user/install-chief-of-staff
 * Body: { confirm: true, userPassword?: string, agentName?: string, skipFiles?: boolean }
 * Creates the CoS agent row. By default also writes its chatspace folder
 * on the server. Pass `skipFiles: true` (the agent-cli.sh path) when the
 * caller will write the files themselves on a user's local machine — the
 * response still includes the full file bundle so the CLI can replicate
 * the agent on disk.
 */
router.post('/install-chief-of-staff', async (req, res) => {
  try {
    const { confirm, userPassword, skipFiles, agentName } = req.body || {};
    if (confirm !== true) {
      return validationError(res, 'confirm: true is required to install the Local Chief of Staff');
    }

    const credsResult = await query(
      `SELECT api_key, encryption_salt FROM users WHERE user_id = $1`,
      [req.user.userId]
    );
    if (credsResult.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'USER_NOT_FOUND', message: 'User record missing' }
      });
    }
    const { api_key, encryption_salt } = credsResult.rows[0];

    const apiBase = `${req.protocol}://${req.get('host')}/api`;

    const result = await chiefOfStaffService.installChiefOfStaff({
      userId: req.user.userId,
      apiKey: api_key,
      encryptionSalt: encryption_salt,
      apiBase,
      userPassword: typeof userPassword === 'string' ? userPassword : '',
      userName: req.user.email ? req.user.email.split('@')[0] : null,
      agentName,
      skipFiles: skipFiles === true
    });

    res.status(201).json({
      success: true,
      ...result
    });
  } catch (error) {
    if (error && error.name === 'ChiefOfStaffError') {
      const status = error.code === 'COS_ALREADY_INSTALLED' ? 409
        : error.code === 'COS_NAME_CONFLICT' ? 409
        : 400;
      return res.status(status).json({
        error: { code: error.code, message: error.message }
      });
    }
    handleDatabaseError(res, error, 'cos install');
  }
});

/**
 * POST /api/user/install-chief-of-staff/files
 * Body: { userPassword?: string, agentName?: string }
 * Returns the full set of files needed to materialize the user's already
 * installed Local Chief of Staff on a new local machine. Used by
 * agent-cli.sh when reinstalling on a fresh machine (e.g. after running
 * curl -sL .../setup | bash on a different computer).
 *
 * Response: { agentName, agentId, fileBundle: { 'relative/path': { content, mode?, sensitive? } } }
 *
 * POST (not GET) so userPassword stays in the request body — not in URL
 * query strings, access logs, or browser history.
 */
router.post('/install-chief-of-staff/files', async (req, res) => {
  try {
    const requestedAgentName = typeof (req.body && req.body.agentName) === 'string'
      ? req.body.agentName
      : '';
    const agent = await chiefOfStaffService.getChiefOfStaffForUser(req.user.userId, {
      agentName: requestedAgentName
    });
    if (!agent) {
      return res.status(404).json({
        error: { code: 'COS_NOT_INSTALLED', message: 'No matching Local Chief of Staff installed for this user' }
      });
    }

    const credsResult = await query(
      `SELECT api_key, encryption_salt FROM users WHERE user_id = $1`,
      [req.user.userId]
    );
    if (credsResult.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'USER_NOT_FOUND', message: 'User record missing' }
      });
    }
    const { api_key, encryption_salt } = credsResult.rows[0];

    const apiBase = `${req.protocol}://${req.get('host')}/api`;
    const userName = req.user.email ? req.user.email.split('@')[0] : null;
    const userPassword = typeof (req.body && req.body.userPassword) === 'string'
      ? req.body.userPassword
      : '';

    const {
      generateChiefOfStaffInstructions
    } = require('../utils/apiGuideGenerator');

    const initialInstructions = generateChiefOfStaffInstructions({ userName, apiBase });

    const fileBundle = chiefOfStaffService.buildChiefOfStaffFileBundle({
      agentName: agent.agent_name,
      agentId: agent.agent_id,
      initialInstructions,
      apiKey: api_key,
      encryptionSalt: encryption_salt,
      apiBase,
      userPassword
    });

    res.json({
      success: true,
      agentName: agent.agent_name,
      agentId: agent.agent_id,
      fileBundle
    });
  } catch (error) {
    handleDatabaseError(res, error, 'cos files');
  }
});

/**
 * GET /api/user/agents
 * Get agent list for authenticated user with metadata
 * 
 * Response: 200 OK
 * - agents: array of agent objects
 *   - agentId: string - UUID of the agent
 *   - name: string - Agent name
 *   - lastMessageId: string|null - UUID of last message
 *   - lastMessageTime: string|null - ISO 8601 timestamp of last message
 *   - lastSeenAt: string|null - ISO 8601 timestamp of the agent's latest poll/heartbeat seen by the server
 *   - lastActivityTime: string|null - ISO 8601 timestamp of last activity (message or agent heartbeat)
 *   - isWorking: boolean - True when runner heartbeat indicates active command execution
 *   - lastWorkingHeartbeatTime: string|null - ISO 8601 timestamp of last working heartbeat
 *   - unreadCount: number - Count of unanswered questions
 *   - highestPriority: 'low' | 'normal' | 'high' - Highest priority of recent messages
 *   - reportedCliVersion: string|null - Last CLI version reported by the agent runtime
 *   - reportedCliVersionAt: string|null - When that version report was seen
 *   - latestCliVersion: string - Current platform-supported agent CLI version
 *   - needsCliUpdate: boolean - True when reportedCliVersion is older than latestCliVersion
 */
router.get('/agents', async (req, res) => {
  try {
    const userId = req.user.userId;

    // Query agents for authenticated user with calculated metadata.
    // Note: we avoid correlated subqueries here to improve compatibility with pg-mem (tests)
    // and to keep the query planner's work predictable.

    // Create archive-aware query with fallback for when archive tables don't exist yet
    const agentsQuery = createArchiveAwareQuery(
      // Primary query with archive filtering
      () => `
        WITH last_message AS (
          SELECT DISTINCT ON (agent_id)
            agent_id,
            message_id AS last_message_id,
            priority AS last_message_priority
          FROM messages
          ORDER BY agent_id, created_at DESC
        )
        SELECT
          agents.agent_id,
          agents.agent_name,
          agents.agent_type,
          ebc.provider as external_provider,
          agents.position,
          agents.last_seen_at,
          agents.is_working,
          agents.last_working_heartbeat_at,
          agents.reported_cli_version,
          agents.reported_cli_version_at,
          MAX(m.created_at) as last_message_time,
          COUNT(CASE WHEN m.read_at IS NULL THEN 1 END) as unread_count,
          MAX(CASE
            WHEN m.message_type = 'question' AND ur.response_id IS NULL AND m.priority = 2 THEN 3
            WHEN m.message_type = 'question' AND ur.response_id IS NULL AND m.priority = 1 THEN 2
            WHEN m.message_type = 'question' AND ur.response_id IS NULL THEN 1
            ELSE 0
          END) as priority_value,
          last_message.last_message_id,
          last_message.last_message_priority
        FROM agents
        LEFT JOIN messages m ON agents.agent_id = m.agent_id
        LEFT JOIN user_responses ur ON m.message_id = ur.message_id
        LEFT JOIN last_message ON last_message.agent_id = agents.agent_id
        LEFT JOIN external_bot_connections ebc ON agents.agent_id = ebc.agent_id
        LEFT JOIN archived_agents aa ON agents.agent_id = aa.agent_id
        WHERE agents.user_id = $1 AND aa.archived_agent_id IS NULL
        GROUP BY
          agents.agent_id,
          agents.agent_name,
          agents.agent_type,
          ebc.provider,
          agents.position,
          agents.last_seen_at,
          agents.is_working,
          agents.last_working_heartbeat_at,
          agents.reported_cli_version,
          agents.reported_cli_version_at,
          last_message.last_message_id,
          last_message.last_message_priority
        ORDER BY agents.position ASC
      `,
      // Fallback query without archive filtering (for when tables don't exist)
      () => `
        WITH last_message AS (
          SELECT DISTINCT ON (agent_id)
            agent_id,
            message_id AS last_message_id,
            priority AS last_message_priority
          FROM messages
          ORDER BY agent_id, created_at DESC
        )
        SELECT
          agents.agent_id,
          agents.agent_name,
          agents.agent_type,
          NULL::text as external_provider,
          agents.position,
          agents.last_seen_at,
          agents.is_working,
          agents.last_working_heartbeat_at,
          agents.reported_cli_version,
          agents.reported_cli_version_at,
          MAX(m.created_at) as last_message_time,
          COUNT(CASE WHEN m.read_at IS NULL THEN 1 END) as unread_count,
          MAX(CASE
            WHEN m.message_type = 'question' AND ur.response_id IS NULL AND m.priority = 2 THEN 3
            WHEN m.message_type = 'question' AND ur.response_id IS NULL AND m.priority = 1 THEN 2
            WHEN m.message_type = 'question' AND ur.response_id IS NULL THEN 1
            ELSE 0
          END) as priority_value,
          last_message.last_message_id,
          last_message.last_message_priority
        FROM agents
        LEFT JOIN messages m ON agents.agent_id = m.agent_id
        LEFT JOIN user_responses ur ON m.message_id = ur.message_id
        LEFT JOIN last_message ON last_message.agent_id = agents.agent_id
        WHERE agents.user_id = $1
        GROUP BY
          agents.agent_id,
          agents.agent_name,
          agents.agent_type,
          agents.position,
          agents.last_seen_at,
          agents.is_working,
          agents.last_working_heartbeat_at,
          agents.reported_cli_version,
          agents.reported_cli_version_at,
          last_message.last_message_id,
          last_message.last_message_priority
        ORDER BY agents.position ASC
      `,
      'get_agents'
    );

    const result = await agentsQuery([userId]);

    // Format agent data with pre-generated TTS audio URLs for new agent notifications
    const agents = await Promise.all(result.rows.map(async (row) => {
      const notificationText = `New agent ${row.agent_name} has joined the council.`;
      const newAgentAudioUrl = await buildNotificationAudioUrl(notificationText);

      // Use last_seen_at (when agent sent message or checked for updates) as the primary activity indicator
      // Fall back to last_message_time if last_seen_at isn't set yet
      const lastActivityTime = row.last_seen_at || row.last_message_time;
      const lastWorkingHeartbeatTime = row.last_working_heartbeat_at;
      const workingHeartbeatAgeMs = lastWorkingHeartbeatTime
        ? (Date.now() - new Date(lastWorkingHeartbeatTime).getTime())
        : Number.POSITIVE_INFINITY;
      const isWorking = row.is_working === true && workingHeartbeatAgeMs <= AGENT_WORKING_HEARTBEAT_MAX_AGE_MS;
      const lastMessageTime = row.last_message_time;
      const lastMessageId = row.last_message_id;
      const reportedCliVersion = row.reported_cli_version || null;
      const reportedCliVersionAt = row.reported_cli_version_at;
      const needsCliUpdate = reportedCliVersion ? isCliVersionOutdated(reportedCliVersion, AGENT_CLI_VERSION) : false;

      return {
        agentId: row.agent_id,
        name: row.agent_name,
        agentType: row.agent_type || 'standard',
        externalProvider: row.external_provider || null,
        position: row.position,
        isWorking,
        lastWorkingHeartbeatTime: lastWorkingHeartbeatTime ? lastWorkingHeartbeatTime.toISOString() : null,
        lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
        lastMessageId: lastMessageId || null,
        lastMessageTime: lastMessageTime ? lastMessageTime.toISOString() : null,
        lastActivityTime: lastActivityTime ? lastActivityTime.toISOString() : null,
        unreadCount: parseInt(row.unread_count) || 0,
        highestPriority: row.priority_value === 3 ? 'high' : row.priority_value === 2 ? 'normal' : 'low',
        lastMessagePriority: row.last_message_priority === 2 ? 'high' : row.last_message_priority === 1 ? 'normal' : 'low',
        reportedCliVersion,
        reportedCliVersionAt: reportedCliVersionAt ? reportedCliVersionAt.toISOString() : null,
        latestCliVersion: AGENT_CLI_VERSION,
        needsCliUpdate,
        newAgentAudioUrl: newAgentAudioUrl
      };
    }));

    // Fetch group data in same request to avoid extra polling calls
    const groupsResult = await query(`
      SELECT g.group_id, g.group_name, g.description,
             COALESCE(json_agg(gm.agent_id) FILTER (WHERE gm.agent_id IS NOT NULL), '[]') as member_ids
      FROM agent_groups g
      LEFT JOIN agent_group_members gm ON g.group_id = gm.group_id
      WHERE g.user_id = $1
      GROUP BY g.group_id, g.group_name, g.description
      ORDER BY g.created_at ASC
    `, [userId]);

    const groups = groupsResult.rows.map(r => ({
      groupId: r.group_id,
      groupName: r.group_name,
      description: r.description || '',
      memberIds: r.member_ids || []
    }));

    res.status(200).json({
      agents: agents,
      groups: groups,
      poll: getPollAdvice(req, agents.length > 0)
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching agents');
  }
});

/**
 * PUT /api/user/agents/positions
 * Update agent positions for the authenticated user
 * 
 * Request body:
 * - updates: array of { agentId: string, position: number }
 * 
 * Response: 200 OK
 * - success: boolean
 */
router.put('/agents/positions', async (req, res) => {
  let client = null;

  try {
    const userId = req.user.userId;
    const { updates } = req.body || {};

    if (!Array.isArray(updates) || updates.length === 0) {
      return validationError(res, 'Updates array is required');
    }

    const uniqueIds = new Set();
    const normalizedUpdates = [];

    for (const update of updates) {
      const agentId = update && update.agentId;
      const position = Number(update && update.position);

      if (!isValidUUID(agentId)) {
        return validationError(res, 'Invalid agent ID format');
      }
      if (!Number.isInteger(position) || position < 1) {
        return validationError(res, 'Position must be a positive integer');
      }
      if (uniqueIds.has(agentId)) {
        return validationError(res, 'Duplicate agent IDs in updates');
      }

      uniqueIds.add(agentId);
      normalizedUpdates.push({ agentId, position });
    }

    const agentIds = Array.from(uniqueIds);
    const ownershipResult = await query(
      'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_id = ANY($2::uuid[])',
      [userId, agentIds]
    );

    if (ownershipResult.rows.length !== agentIds.length) {
      logUnauthorizedAccess(req, 'agent', agentIds.join(','), 'User does not own one or more agents');
      return forbiddenError(res, 'You do not have access to one or more agents');
    }

    client = await getClient();
    await client.query('BEGIN');

    for (const update of normalizedUpdates) {
      await client.query(
        'UPDATE agents SET position = $1 WHERE agent_id = $2 AND user_id = $3',
        [update.position, update.agentId, userId]
      );
    }

    await client.query('COMMIT');

    res.status(200).json({ success: true });

  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to rollback agent position update', rollbackError);
      }
    }
    return handleDatabaseError(res, error, 'updating agent positions');
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * GET /api/user/usage-limits
 * Lets the signed-in user check how close their account and each of their
 * agents are to the API rate limits, so the dashboard/settings UI can
 * surface it without them having to inspect response headers.
 */
router.get('/usage-limits', async (req, res) => {
  try {
    const userId = req.user.userId;
    const clientIdentifier = resolveClientIdentifier(req);

    const agentsQuery = createArchiveAwareQuery(
      () => `
        SELECT a.agent_name
        FROM agents a
        LEFT JOIN archived_agents aa ON a.agent_id = aa.agent_id
        WHERE a.user_id = $1 AND aa.archived_agent_id IS NULL
        ORDER BY a.agent_name`,
      () => `
        SELECT a.agent_name
        FROM agents a
        WHERE a.user_id = $1
        ORDER BY a.agent_name`,
      'usage_limits_agents'
    );
    const agentsResult = await agentsQuery([userId]);

    const [apiAggregate, perAgent] = await Promise.all([
      getUsageStatus(agentApiRateLimiter, { clientIdentifier }),
      Promise.all(agentsResult.rows.map(async (row) => {
        const agentName = row.agent_name;
        const [polling, messageIngress] = await Promise.all([
          getUsageStatus(agentPollingRateLimiter, { clientIdentifier, agentName }),
          getUsageStatus(agentMessageIngressRateLimiter, { clientIdentifier, agentName })
        ]);
        return {
          agentName,
          limits: [
            { ...polling, label: 'Polling requests' },
            { ...messageIngress, label: 'Messages sent' }
          ]
        };
      }))
    ]);

    return res.status(200).json({
      account: {
        limits: [
          { ...apiAggregate, label: 'Total API requests (all your agents)' }
        ]
      },
      agents: perAgent
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'fetching usage limits');
  }
});

/**
 * GET /api/user/agents/:agentId/details
 * Return runtime details shown when the user clicks an agent name.
 */
router.get('/agents/:agentId/details', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;

    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agent ID format');
    }

    const agentResult = await query(
      `SELECT agent_id, agent_name
       FROM agents
       WHERE agent_id = $1 AND user_id = $2`,
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Agent not found' } });
    }

    const agent = agentResult.rows[0];
    const folderName = sanitizeFolderName(agent.agent_name);
    const folderPath = findAgentLocalDir(folderName);
    const runtimeState = await loadAgentRuntimeState({
      userId,
      agentId,
      agentName: agent.agent_name
    });

    const runtimeConfig = runtimeState?.config || {};
    const projectPath = typeof runtimeConfig.project_path === 'string' && runtimeConfig.project_path.trim()
      ? runtimeConfig.project_path.trim()
      : typeof runtimeConfig.projectPath === 'string' && runtimeConfig.projectPath.trim()
        ? runtimeConfig.projectPath.trim()
        : null;

    res.json({
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      machineName: os.hostname() || null,
      machineIp: getPrimaryLocalIpAddress(),
      folderName,
      folderPath,
      projectPath,
      chatspaceRoot: folderPath ? path.dirname(folderPath) : getChatspaceRoot(),
      sameMachine: folderPath ? true : null
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'fetching agent runtime details');
  }
});

/**
 * GET /api/user/messages/:agentId
 * Get messages for a specific agent, including user replies
 *
 * Path parameters:
 * - agentId: string - UUID of the agent
 *
 * Query parameters:
 * - since: ISO 8601 timestamp (optional) - Only return messages after this time
 * - cursor: numeric value (optional) - Optional polling cursor (microsecond timestamp)
 *
 * Response: 200 OK
 * - messages: array of message objects
 *   - messageId: string - UUID of the message
 *   - type: 'agent_message' | 'agent_question' | 'user_message'
 *   - content: string - Message content
 *   - priority: 'low' | 'normal' | 'high'
 *   - urgent: boolean
 *   - timestamp: string - ISO 8601 timestamp
 *   - cursor: string|null - Cursor value for polling continuity
 *   - attachments: array - Array of attachment metadata objects
 *     - attachmentId: string - UUID of the attachment
 *     - contentType: string - MIME type (e.g., 'image/png')
 *     - fileName: string|null - Original filename
 *     - sizeBytes: number - Size of encrypted file
 *     - width: number|null - Image width in pixels
 *     - height: number|null - Image height in pixels
 *     - encrypted: boolean - Whether attachment is encrypted
 *     - encryption: object|null - Encryption metadata (if encrypted)
 *       - alg: string - Algorithm ('AES-GCM')
 *       - ivBase64: string - Base64-encoded IV
 *       - tagBase64: string - Base64-encoded auth tag
 *     - downloadUrl: string - URL to download the attachment
 *   - options: array (only for questions) - Array of option objects
 *     - optionId: string
 *     - text: string
 *     - benefits: string|null
 *     - downsides: string|null
 *     - isDefault: boolean
 *     - order: number
 *   - selectedOption: string|null (only for questions) - Text of selected option if answered
 */

/**
 * GET /api/user/messages/all
 * Get messages from all agents belonging to the user, merged and sorted by timestamp.
 * Each message includes agentId and agentName fields.
 * Supports ?cursor= for incremental polling.
 */
router.get('/messages/all', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { cursor, since } = req.query;

    let cursorValue = null;
    let sinceValue = null;

    if (cursor) {
      if (!/^\d+$/.test(cursor)) {
        return validationError(res, 'Cursor must be a numeric value');
      }
      cursorValue = cursor;
    } else if (since) {
      const timestampValidation = validateTimestamp(since);
      if (!timestampValidation.valid) {
        return validationError(res, timestampValidation.message);
      }
      const formattedSince = formatTimestampForDatabase(timestampValidation.date);
      if (!formattedSince) {
        return validationError(res, 'Invalid timestamp format');
      }
      sinceValue = formattedSince;
    }

    const timeFilter = cursorValue !== null
      ? ` AND (EXTRACT(EPOCH FROM created_at) * 1000000)::BIGINT > $2`
      : (sinceValue ? ` AND created_at > $2` : '');
    const timeParam = cursorValue !== null ? cursorValue : sinceValue;
    const params = timeParam ? [userId, timeParam] : [userId];

    const schemaCapabilities = await getMessageSchemaCapabilities();
    const messageHiddenSelect = schemaCapabilities.hasMessagesHiddenFromAgent
      ? 'm.hidden_from_agent'
      : 'FALSE AS hidden_from_agent';

    const fetchAllRows = async (includeRunCommand) => {
      const messageRunCommandSelect = includeRunCommand
        ? 'm.run_command AS run_command'
        : 'NULL AS run_command';

      try {
        const result = await query(`
        SELECT
          m.message_id AS id,
          m.message_type AS msg_type,
          m.content,
          m.encrypted,
          m.priority,
          m.urgent,
          ${messageHiddenSelect},
          ${messageRunCommandSelect},
          m.created_at,
          (EXTRACT(EPOCH FROM m.created_at) * 1000000)::BIGINT AS created_at_micro,
          a.agent_id,
          a.agent_name
        FROM messages m
        JOIN agents a ON m.agent_id = a.agent_id
        LEFT JOIN archived_messages am ON m.message_id = am.message_id
        WHERE a.user_id = $1 AND am.archived_message_id IS NULL${timeFilter}
        UNION ALL
        SELECT
          um.user_message_id AS id,
          'user_message' AS msg_type,
          um.content,
          um.encrypted,
          0 AS priority,
          FALSE AS urgent,
          FALSE AS hidden_from_agent,
          NULL AS run_command,
          um.created_at,
          (EXTRACT(EPOCH FROM um.created_at) * 1000000)::BIGINT AS created_at_micro,
          a.agent_id,
          a.agent_name
        FROM user_messages um
        JOIN agents a ON um.agent_id = a.agent_id
        LEFT JOIN archived_messages am ON um.user_message_id = am.user_message_id
        WHERE a.user_id = $1 AND am.archived_message_id IS NULL${timeFilter}
        ORDER BY created_at_micro ASC
        LIMIT 500
      `, params);
        return result.rows;
      } catch (archiveErr) {
        if (archiveErr.code !== '42P01') throw archiveErr;
        // Fallback: no archived_messages table
        const result = await query(`
        SELECT
          m.message_id AS id,
          m.message_type AS msg_type,
          m.content,
          m.encrypted,
          m.priority,
          m.urgent,
          FALSE AS hidden_from_agent,
          NULL AS run_command,
          m.created_at,
          (EXTRACT(EPOCH FROM m.created_at) * 1000000)::BIGINT AS created_at_micro,
          a.agent_id,
          a.agent_name
        FROM messages m
        JOIN agents a ON m.agent_id = a.agent_id
        WHERE a.user_id = $1${timeFilter}
        UNION ALL
        SELECT
          um.user_message_id AS id,
          'user_message' AS msg_type,
          um.content,
          um.encrypted,
          0 AS priority,
          FALSE AS urgent,
          FALSE AS hidden_from_agent,
          NULL AS run_command,
          um.created_at,
          (EXTRACT(EPOCH FROM um.created_at) * 1000000)::BIGINT AS created_at_micro,
          a.agent_id,
          a.agent_name
        FROM user_messages um
        JOIN agents a ON um.agent_id = a.agent_id
        WHERE a.user_id = $1${timeFilter}
        ORDER BY created_at_micro ASC
        LIMIT 500
      `, params);
        return result.rows;
      }
    };

    // Fetch agent messages + user messages for all agents owned by this user
    let allRows;
    try {
      allRows = await fetchAllRows(schemaCapabilities.hasMessagesRunCommand);
    } catch (error) {
      if (!isMissingColumnError(error, 'run_command')) throw error;
      allRows = await fetchAllRows(false);
    }

    const messages = allRows.map(row => ({
      messageId: row.id,
      type: row.msg_type === 'question' ? 'agent_question' : (row.msg_type === 'user_message' ? 'user_message' : 'agent_message'),
      content: row.content,
      encrypted: row.encrypted || false,
      priority: row.priority || 'normal',
      urgent: row.urgent || false,
      hiddenFromAgent: row.hidden_from_agent || false,
      runCommand: row.run_command || null,
      timestamp: row.created_at.toISOString(),
      cursor: row.created_at_micro,
      agentId: row.agent_id,
      agentName: row.agent_name,
      attachments: []
    }));

    res.status(200).json({
      messages,
      poll: getPollAdvice(req, messages.length > 0)
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'fetching all messages');
  }
});

router.get('/messages/:agentId([0-9a-fA-F-]{36})', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;
    const { since, cursor, limit: limitParam } = req.query;

    const requestedLimit = limitParam ? parseInt(limitParam, 10) : null;
    const hasValidLimit = requestedLimit && Number.isFinite(requestedLimit) && requestedLimit > 0 && requestedLimit <= 500;

    // Validate UUID format
    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agent ID format');
    }

    // Validate user owns the agent
    const agentResult = await query(
      'SELECT agent_id, agent_name FROM agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      // Log unauthorized access attempt
      logUnauthorizedAccess(req, 'agent', agentId, 'User does not own this agent');
      return forbiddenError(res, 'You do not have access to this agent');
    }

    const agentName = agentResult.rows[0].agent_name;

    let cursorValue = null;
    let sinceValue = null;
    const schemaCapabilities = await getMessageSchemaCapabilities();

    const messageHiddenFromAgentSelect = schemaCapabilities.hasMessagesHiddenFromAgent
      ? 'm.hidden_from_agent'
      : 'FALSE AS hidden_from_agent';
    const userMessageHiddenFromAgentSelect = 'um.hidden_from_agent';

    if (cursor) {
      if (!/^\d+$/.test(cursor)) {
        return validationError(res, 'Cursor must be a numeric value');
      }
      cursorValue = cursor;
    } else if (since) {
      const timestampValidation = validateTimestamp(since);
      if (!timestampValidation.valid) {
        return validationError(res, timestampValidation.message);
      }

      const formattedSince = formatTimestampForDatabase(timestampValidation.date);
      if (!formattedSince) {
        return validationError(res, 'Invalid timestamp format');
      }

      sinceValue = formattedSince;
    }

    const buildTimeFilter = (alias) => {
      if (cursorValue !== null) {
        return ` AND (EXTRACT(EPOCH FROM ${alias}.created_at) * 1000000)::BIGINT > $2`;
      }
      if (sinceValue) {
        return ` AND ${alias}.created_at > $2`;
      }
      return '';
    };

    const messageParams = [agentId];
    if (cursorValue !== null || sinceValue) {
      messageParams.push(cursorValue !== null ? cursorValue : sinceValue);
    }

    const buildMessagesQuery = (includeRunCommand) => {
      const messageRunCommandSelect = includeRunCommand
        ? 'm.run_command AS run_command'
        : 'NULL AS run_command';

      return createArchiveAwareQuery(
        // Primary query with archive filtering
        () => `
        SELECT
          m.message_id,
          m.message_type,
          m.content,
          m.encrypted,
          m.priority,
          m.urgent,
          m.allow_free_response,
          m.free_response_hint,
          ${messageHiddenFromAgentSelect},
          ${messageRunCommandSelect},
          m.read_at,
          m.created_at,
          (EXTRACT(EPOCH FROM m.created_at) * 1000000)::BIGINT as created_at_micro
        FROM messages m
        LEFT JOIN archived_messages am ON m.message_id = am.message_id
        WHERE m.agent_id = $1 AND am.archived_message_id IS NULL${buildTimeFilter('m')}
        ORDER BY m.created_at ASC
      `,
        // Fallback query without archive filtering
        () => `
        SELECT
          m.message_id,
          m.message_type,
          m.content,
          m.encrypted,
          m.priority,
          m.urgent,
          m.allow_free_response,
          m.free_response_hint,
          ${messageHiddenFromAgentSelect},
          ${messageRunCommandSelect},
          m.read_at,
          m.created_at,
          (EXTRACT(EPOCH FROM m.created_at) * 1000000)::BIGINT as created_at_micro
        FROM messages m
        WHERE m.agent_id = $1${buildTimeFilter('m')}
        ORDER BY m.created_at ASC
      `,
        'get_messages'
      );
    };

    let messagesResult;
    try {
      messagesResult = await buildMessagesQuery(schemaCapabilities.hasMessagesRunCommand)(messageParams);
    } catch (error) {
      if (!isMissingColumnError(error, 'run_command')) throw error;
      messagesResult = await buildMessagesQuery(false)(messageParams);
    }

    // Mark all fetched messages as read.
    // Prefer bulk updates, but fall back to per-row updates for test DBs (pg-mem)
    // that don't fully support `ANY($1)` array binding semantics.
    if (messagesResult.rows.length > 0) {
      const unreadMessageIds = messagesResult.rows
        .filter(row => !row.read_at)
        .map(row => row.message_id);

      if (unreadMessageIds.length > 0) {
        const updated = await query(
          `UPDATE messages SET read_at = NOW()::timestamp WHERE message_id = ANY($1) AND read_at IS NULL`,
          [unreadMessageIds]
        );

        if (SHOULD_USE_TEST_DB_BULK_FALLBACK && ((updated && updated.rowCount) || 0) !== unreadMessageIds.length) {
          for (const messageId of unreadMessageIds) {
            await query(
              'UPDATE messages SET read_at = NOW()::timestamp WHERE message_id = $1 AND read_at IS NULL',
              [messageId]
            );
          }
        }
      }
    }

    // Fetch attachments for agent messages (avoid N+1 queries)
    const agentMessageIds = messagesResult.rows.map(row => row.message_id);
    const agentAttachmentsMap = {};
    if (agentMessageIds.length > 0) {
      const agentAttachmentsResult = await query(`
        SELECT
          ma.message_id,
          ma.attachment_order,
          a.attachment_id,
          a.content_type,
          a.file_name,
          a.size_bytes,
          a.width,
          a.height,
          a.encrypted,
          a.iv_base64,
          a.auth_tag_base64
        FROM message_attachments ma
        JOIN attachments a ON ma.attachment_id = a.attachment_id
        WHERE ma.message_id = ANY($1)
        ORDER BY ma.message_id, ma.attachment_order ASC
      `, [agentMessageIds]);

      // Group attachments by message_id
      for (const att of agentAttachmentsResult.rows) {
        if (!agentAttachmentsMap[att.message_id]) {
          agentAttachmentsMap[att.message_id] = [];
        }
        agentAttachmentsMap[att.message_id].push({
          attachmentId: att.attachment_id,
          contentType: att.content_type,
          fileName: att.file_name,
          sizeBytes: parseInt(att.size_bytes, 10),
          width: att.width,
          height: att.height,
          encrypted: att.encrypted,
          encryption: att.encrypted ? {
            alg: 'AES-GCM',
            ivBase64: att.iv_base64,
            tagBase64: att.auth_tag_base64
          } : null,
          downloadUrl: `/api/user/attachments/${att.attachment_id}`
        });
      }
    }

    // Format messages and fetch additional data for questions
    const messages = [];

    for (const row of messagesResult.rows) {
      const message = {
        messageId: row.message_id,
        type: row.message_type === 'question' ? 'agent_question' : 'agent_message',
        content: row.content,
        encrypted: row.encrypted || false,
        priority: row.priority,
        urgent: row.urgent,
        allowFreeResponse: row.allow_free_response,
        freeResponseHint: row.free_response_hint,
        hiddenFromAgent: row.hidden_from_agent || false,
        runCommand: row.run_command || null,
        timestamp: row.created_at.toISOString(),
        cursor: row.created_at_micro,
        attachments: agentAttachmentsMap[row.message_id] || []
      };

      if (row.message_type === 'question') {
        const optionsResult = await query(
          `SELECT
            option_id,
            option_text,
            benefits,
            downsides,
            is_default,
            option_order
          FROM question_options
          WHERE message_id = $1
          ORDER BY option_order ASC`,
          [row.message_id]
        );

        message.options = optionsResult.rows.map(opt => ({
          optionId: opt.option_id,
          text: opt.option_text,
          benefits: opt.benefits,
          downsides: opt.downsides,
          isDefault: opt.is_default,
          order: opt.option_order
        }));

        const responseResult = await query(
          `SELECT ur.free_response, qo.option_text
          FROM user_responses ur
          LEFT JOIN question_options qo ON ur.option_id = qo.option_id
          WHERE ur.message_id = $1`,
          [row.message_id]
        );

        if (responseResult.rows.length > 0) {
          message.selectedOption = responseResult.rows[0].option_text || null;
          message.freeResponse = responseResult.rows[0].free_response || null;
        } else {
          message.selectedOption = null;
          message.freeResponse = null;
        }
      }

      if (message.type === 'agent_message' || message.type === 'agent_question') {
        const notificationText = buildNotificationText(agentName, message.type, message.priority, message.urgent);
        message.notificationText = notificationText;
        message.notificationAudioUrl = await buildNotificationAudioUrl(notificationText);
      }

      messages.push(message);
    }

    const userMessageParams = [agentId];
    if (cursorValue !== null || sinceValue) {
      userMessageParams.push(cursorValue !== null ? cursorValue : sinceValue);
    }

    const buildUserMessagesQueryFn = (hiddenSelectSql) => createArchiveAwareQuery(
      // Primary query with archive filtering
      () => `
        SELECT
          um.user_message_id,
          um.content,
          um.encrypted,
          um.created_at,
          um.read_at,
          ${hiddenSelectSql},
          a.is_working,
          a.last_working_heartbeat_at,
          (EXTRACT(EPOCH FROM um.created_at) * 1000000)::BIGINT as created_at_micro
        FROM user_messages um
        JOIN agents a ON a.agent_id = um.agent_id
        LEFT JOIN archived_messages am ON um.user_message_id = am.user_message_id
        WHERE um.agent_id = $1 AND am.archived_message_id IS NULL${buildTimeFilter('um')}
        ORDER BY um.created_at ASC
      `,
      // Fallback query without archive filtering
      () => `
        SELECT
          um.user_message_id,
          um.content,
          um.encrypted,
          um.created_at,
          um.read_at,
          ${hiddenSelectSql},
          a.is_working,
          a.last_working_heartbeat_at,
          (EXTRACT(EPOCH FROM um.created_at) * 1000000)::BIGINT as created_at_micro
        FROM user_messages um
        JOIN agents a ON a.agent_id = um.agent_id
        WHERE um.agent_id = $1${buildTimeFilter('um')}
        ORDER BY um.created_at ASC
      `,
      'get_user_messages'
    );

    let userMessagesResult;
    try {
      userMessagesResult = await buildUserMessagesQueryFn(userMessageHiddenFromAgentSelect)(userMessageParams);
    } catch (userMessagesError) {
      if (userMessagesError.code !== '42703') {
        throw userMessagesError;
      }

      // Backward compatibility: older schemas may not have user_messages.hidden_from_agent.
      userMessagesResult = await buildUserMessagesQueryFn('FALSE AS hidden_from_agent')(userMessageParams);
    }

    // Fetch attachments for user messages (avoid N+1 queries)
    const userMessageIds = userMessagesResult.rows.map(row => row.user_message_id);
    const userAttachmentsMap = {};
    if (userMessageIds.length > 0) {
      const userAttachmentsResult = await query(`
        SELECT
          uma.user_message_id,
          uma.attachment_order,
          a.attachment_id,
          a.content_type,
          a.file_name,
          a.size_bytes,
          a.width,
          a.height,
          a.encrypted,
          a.iv_base64,
          a.auth_tag_base64
        FROM user_message_attachments uma
        JOIN attachments a ON uma.attachment_id = a.attachment_id
        WHERE uma.user_message_id = ANY($1)
        ORDER BY uma.user_message_id, uma.attachment_order ASC
      `, [userMessageIds]);

      // Group attachments by user_message_id
      for (const att of userAttachmentsResult.rows) {
        if (!userAttachmentsMap[att.user_message_id]) {
          userAttachmentsMap[att.user_message_id] = [];
        }
        userAttachmentsMap[att.user_message_id].push({
          attachmentId: att.attachment_id,
          contentType: att.content_type,
          fileName: att.file_name,
          sizeBytes: parseInt(att.size_bytes, 10),
          width: att.width,
          height: att.height,
          encrypted: att.encrypted,
          encryption: att.encrypted ? {
            alg: 'AES-GCM',
            ivBase64: att.iv_base64,
            tagBase64: att.auth_tag_base64
          } : null,
          downloadUrl: `/api/user/attachments/${att.attachment_id}`
        });
      }
    }

    // Build user messages array (read_at and hidden_from_agent are already in the query result)
    const queuedUpdatePrefix = '__AGENT_UPDATE__:';
    const nowMs = Date.now();
    const userMessages = userMessagesResult.rows.map(row => {
      const readAtIso = row.read_at ? row.read_at.toISOString() : null;
      const delivery = buildUserMessageDeliveryState({
        readAt: row.read_at,
        createdAt: row.created_at,
        hiddenFromAgent: row.hidden_from_agent || false,
        agentIsWorking: row.is_working === true,
        agentLastWorkingHeartbeatAt: row.last_working_heartbeat_at
      }, nowMs);
      const isQueuedSelfUpdate =
        typeof row.content === 'string' && row.content.startsWith(queuedUpdatePrefix);

      if (isQueuedSelfUpdate) {
        return {
          messageId: row.user_message_id,
          type: 'user_message',
          messageSubtype: 'queued_self_update',
          content: 'Agent self-update package queued. Click "Confirm Update" to apply it on the next agent poll.',
          encrypted: false,
          priority: 0,
          urgent: false,
          timestamp: row.created_at.toISOString(),
          cursor: row.created_at_micro,
          readAt: readAtIso,
          hiddenFromAgent: row.hidden_from_agent || false,
          deliveryState: delivery.deliveryState,
          deliveryFailed: delivery.deliveryFailed,
          failedReason: delivery.failedReason,
          attachments: userAttachmentsMap[row.user_message_id] || []
        };
      }

      return {
        messageId: row.user_message_id,
        type: 'user_message',
        content: row.content,
        encrypted: row.encrypted || false,
        priority: 0,
        urgent: false,
        timestamp: row.created_at.toISOString(),
        cursor: row.created_at_micro,
        readAt: readAtIso,
        hiddenFromAgent: row.hidden_from_agent || false,
        deliveryState: delivery.deliveryState,
        deliveryFailed: delivery.deliveryFailed,
        failedReason: delivery.failedReason,
        attachments: userAttachmentsMap[row.user_message_id] || []
      };
    });

    // Fetch inter-agent messages (DMs sent and received by this agent)
    const interAgentParams = [agentId];
    if (cursorValue !== null || sinceValue) {
      interAgentParams.push(cursorValue !== null ? cursorValue : sinceValue);
    }

    let interAgentMessagesResult = { rows: [] };
    try {
      interAgentMessagesResult = await query(`
        SELECT
          am.agent_message_id,
          am.content,
          am.encrypted,
          am.priority,
          am.created_at,
          am.sender_agent_id,
          am.recipient_agent_id,
          sender.agent_name as sender_name,
          recipient.agent_name as recipient_name,
          (EXTRACT(EPOCH FROM am.created_at) * 1000000)::BIGINT as created_at_micro
        FROM agent_messages am
        JOIN agents sender ON am.sender_agent_id = sender.agent_id
        JOIN agents recipient ON am.recipient_agent_id = recipient.agent_id
        WHERE (am.sender_agent_id = $1 OR am.recipient_agent_id = $1)${cursorValue !== null ? ' AND (EXTRACT(EPOCH FROM am.created_at) * 1000000)::BIGINT > $2' : (sinceValue ? ' AND am.created_at > $2' : '')}
        ORDER BY am.created_at ASC
      `, interAgentParams);
    } catch (interAgentError) {
      // Backward compatibility: older deployments may not have the agent_messages table yet.
      if (interAgentError.code !== '42P01') {
        throw interAgentError;
      }
    }

    // Build inter-agent messages array
    const interAgentMessages = interAgentMessagesResult.rows.map(row => {
      const isSender = row.sender_agent_id === agentId;
      return {
        messageId: row.agent_message_id,
        type: isSender ? 'agent_dm_sent' : 'agent_dm_received',
        from: isSender ? agentName : `agent:${row.sender_name}`,
        to: isSender ? `agent:${row.recipient_name}` : agentName,
        otherAgent: isSender ? row.recipient_name : row.sender_name,
        content: row.content,
        encrypted: row.encrypted || false,
        priority: row.priority || 0,
        urgent: false,
        timestamp: row.created_at.toISOString(),
        cursor: row.created_at_micro,
        hiddenFromAgent: false,
        attachments: []
      };
    });

    const combinedMessages = [...messages, ...userMessages, ...interAgentMessages].sort((a, b) => {
      return new Date(a.timestamp) - new Date(b.timestamp);
    });

    if (hasValidLimit && !cursorValue && !sinceValue && combinedMessages.length > requestedLimit) {
      const sliced = combinedMessages.slice(-requestedLimit);
      res.status(200).json({
        messages: sliced,
        hasMore: true,
        oldestCursor: sliced[0]?.cursor || null,
        totalCount: combinedMessages.length,
        poll: getPollAdvice(req, sliced.length > 0)
      });
    } else {
      res.status(200).json({
        messages: combinedMessages,
        hasMore: false,
        poll: getPollAdvice(req, combinedMessages.length > 0)
      });
    }

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching messages');
  }
});

/**
 * GET /api/user/messages/:agentId/status
 * Get read status for multiple user messages in one request.
 *
 * Query:
 * - ids: comma-separated UUID list, max 100
 */
router.get('/messages/:agentId/status', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;
    const idsParam = String(req.query.ids || '');
    const messageIds = [...new Set(idsParam.split(',').map((id) => id.trim()).filter(Boolean))];

    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agent ID format');
    }

    if (messageIds.length === 0) {
      return res.status(200).json({
        statuses: [],
        poll: getPollAdvice(req, false)
      });
    }

    if (messageIds.length > 100 || messageIds.some((messageId) => !isValidUUID(messageId))) {
      return validationError(res, 'Invalid message ID list');
    }

    const agentCheck = await query(
      'SELECT agent_id FROM agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentCheck.rows.length === 0) {
      return forbiddenError(res, 'Agent not found or access denied');
    }

    const result = await fetchUserMessageStatusRows(agentId, messageIds);
    const rowsById = new Map(result.rows.map((row) => [row.user_message_id, row]));
    const statuses = messageIds
      .filter((messageId) => rowsById.has(messageId))
      .map((messageId) => formatUserMessageStatusRow(rowsById.get(messageId), messageId));

    res.status(200).json({
      statuses,
      poll: getPollAdvice(req, statuses.length > 0)
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'fetching message statuses');
  }
});

/**
 * GET /api/user/messages/:agentId/status/:messageId
 * Get read status for a specific user message
 * 
 * Response: 200 OK
 * - messageId: string - UUID of the message
 * - readAt: string|null - ISO 8601 timestamp when agent read the message, or null
 * - deliveryState: 'pending' | 'read' | 'failed' - Delivery state for user visibility
 * - deliveryFailed: boolean - True when message timed out (2m) without read and agent is not working
 * - failedReason: string|null - Failure reason code when deliveryFailed=true
 */
router.get('/messages/:agentId/status/:messageId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId, messageId } = req.params;

    if (!isValidUUID(agentId) || !isValidUUID(messageId)) {
      return validationError(res, 'Invalid ID format');
    }

    // Verify the agent belongs to this user
    const agentCheck = await query(
      'SELECT agent_id FROM agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentCheck.rows.length === 0) {
      return forbiddenError(res, 'Agent not found or access denied');
    }

    const result = await fetchUserMessageStatusRows(agentId, [messageId]);

    if (result.rows.length === 0) {
      return validationError(res, 'Message not found');
    }

    res.status(200).json(formatUserMessageStatusRow(result.rows[0], messageId));

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching message status');
  }
});

/**
 * PUT /api/user/messages/:messageId/hidden
 * Toggle whether a user message is hidden from the agent
 * 
 * Messages that are hidden will still be visible to the user in the dashboard,
 * but will not be sent to the agent when they poll for responses.
 * 
 * Request body:
 * - hidden: boolean (required) - Whether to hide the message from the agent
 * 
 * Response: 200 OK
 * - success: boolean - Operation status
 * - hidden: boolean - New hidden state
 */
router.put('/messages/:messageId/hidden', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { messageId } = req.params;
    const { hidden } = req.body;

    if (!isValidUUID(messageId)) {
      return validationError(res, 'Invalid message ID format');
    }

    if (typeof hidden !== 'boolean') {
      return validationError(res, 'hidden must be a boolean');
    }

    // Verify the message belongs to an agent owned by this user
    const verifyResult = await query(
      `SELECT um.user_message_id 
       FROM user_messages um
       JOIN agents a ON um.agent_id = a.agent_id
       WHERE um.user_message_id = $1 AND a.user_id = $2`,
      [messageId, userId]
    );

    if (verifyResult.rows.length === 0) {
      return forbiddenError(res, 'Message not found or access denied');
    }

    await query(
      'UPDATE user_messages SET hidden_from_agent = $1 WHERE user_message_id = $2',
      [hidden, messageId]
    );

    res.status(200).json({ success: true, hidden });
  } catch (error) {
    return handleDatabaseError(res, error, 'toggling message visibility');
  }
});

/**
 * PUT /api/user/agent-messages/:messageId/hidden
 * Toggle visibility of an agent message from being sent back to the agent
 *
 * This allows users to hide specific agent responses from the conversation
 * history that gets sent to the agent on future polls
 *
 * Path parameters:
 * - messageId: string (required) - UUID of the agent message
 *
 * Request body:
 * - hidden: boolean (required) - Whether to hide the message from the agent
 *
 * Response: 200 OK
 * - success: boolean
 * - hidden: boolean - The new hidden state
 */
router.put('/agent-messages/:messageId/hidden', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { messageId } = req.params;
    const { hidden } = req.body;

    if (!isValidUUID(messageId)) {
      return validationError(res, 'Invalid message ID format');
    }

    if (typeof hidden !== 'boolean') {
      return validationError(res, 'hidden must be a boolean');
    }

    // Verify the message belongs to an agent owned by this user
    const verifyResult = await query(
      `SELECT m.message_id
       FROM messages m
       JOIN agents a ON m.agent_id = a.agent_id
       WHERE m.message_id = $1 AND a.user_id = $2`,
      [messageId, userId]
    );

    if (verifyResult.rows.length === 0) {
      return forbiddenError(res, 'Message not found or access denied');
    }

    await query(
      'UPDATE messages SET hidden_from_agent = $1 WHERE message_id = $2',
      [hidden, messageId]
    );

    res.status(200).json({ success: true, hidden });
  } catch (error) {
    return handleDatabaseError(res, error, 'toggling agent message visibility');
  }
});

/**
 * POST /api/user/messages
 * Submit a free-text reply to an agent
 *
 * Request body:
 * - agentId: string (required) - UUID of the agent
 * - content: string (required unless attachmentIds provided) - Text to send to the agent
 * - encrypted: boolean (optional) - Whether content is encrypted
 * - attachmentIds: string[] (optional) - Array of attachment UUIDs to attach to the message
 *
 * Response: 201 Created
 * - messageId: string - UUID of the created user message
 * - timestamp: string - ISO 8601 timestamp of when the message was stored
 * - attachmentCount: number - Number of attachments attached
 */
router.post('/messages', async (req, res) => {
  const client = await getClient();

  try {
    const userId = req.user.userId;
    const { agentId, content, encrypted, attachmentIds, runOverrides } = req.body;
    const isEncrypted = encrypted === true;

    if (!agentId) {
      client.release();
      return validationError(res, 'Agent ID is required');
    }

    if (!isValidUUID(agentId)) {
      client.release();
      return validationError(res, 'Invalid agent ID format');
    }

    // Validate attachment IDs if provided
    const attachmentValidation = validateAttachmentIds(attachmentIds);
    if (!attachmentValidation.valid) {
      client.release();
      return validationError(res, attachmentValidation.message);
    }
    const validatedAttachmentIds = attachmentValidation.ids;
    const hasAttachments = validatedAttachmentIds.length > 0;

    // Validate message content (allow empty if attachments are present)
    const contentValidation = validateMessageContent(content, { allowEmpty: hasAttachments });
    if (!contentValidation.valid) {
      client.release();
      return validationError(res, contentValidation.message);
    }

    // Require either content or attachments
    const hasContent = content && typeof content === 'string' && content.trim().length > 0;
    if (!hasContent && !hasAttachments) {
      client.release();
      return validationError(res, 'Message must have either content or attachments');
    }

    // Start transaction
    await client.query('BEGIN');

    const agentResult = await client.query(
      `SELECT agent_id, agent_name FROM agents WHERE agent_id = $1 AND user_id = $2${process.env.FEATURE_IN_PLACE_AGENT_SHARING === 'true' ? ' FOR UPDATE' : ''}`,
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      logUnauthorizedAccess(req, 'agent', agentId, 'User does not own this agent');
      return forbiddenError(res, 'You do not have access to this agent');
    }

    const agentName = agentResult.rows[0].agent_name;

    if (process.env.FEATURE_IN_PLACE_AGENT_SHARING === 'true') {
      await chatThreadService.assertPrivateThreadWritable(client, agentId, userId);
    }

    const overridesCheck = await resolveRunOverrides(agentId, agentName, runOverrides);
    if (!overridesCheck.valid) {
      await client.query('ROLLBACK');
      client.release();
      return validationError(res, overridesCheck.message);
    }
    const validatedOverrides = overridesCheck.value ? JSON.stringify(overridesCheck.value) : null;

    // Verify attachments exist, belong to this agent, and are not already attached to another message
    if (hasAttachments) {
      const attachmentCheck = await client.query(
        `SELECT attachment_id FROM attachments
         WHERE attachment_id = ANY($1)
         AND agent_id = $2`,
        [validatedAttachmentIds, agentId]
      );

      if (attachmentCheck.rows.length !== validatedAttachmentIds.length) {
        await client.query('ROLLBACK');
        client.release();
        return validationError(res, 'One or more attachment IDs are invalid or do not belong to this agent');
      }

      // Check if any attachments are already linked to a user message
      const alreadyLinked = await client.query(
        `SELECT attachment_id FROM user_message_attachments
         WHERE attachment_id = ANY($1)`,
        [validatedAttachmentIds]
      );

      if (alreadyLinked.rows.length > 0) {
        await client.query('ROLLBACK');
        client.release();
        return validationError(res, 'One or more attachments are already attached to another message');
      }
    }

    // Insert user message
    // Content can be null if only attachments are provided
    const finalContent = hasContent ? content.trim() : null;
    const insertResult = await client.query(
      `INSERT INTO user_messages (agent_id, content, encrypted, run_overrides)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING user_message_id, created_at`,
      [agentId, finalContent, isEncrypted, validatedOverrides]
    );

    const userMessageId = insertResult.rows[0].user_message_id;

    // Link attachments to the user message
    if (hasAttachments) {
      for (let i = 0; i < validatedAttachmentIds.length; i++) {
        await client.query(
          `INSERT INTO user_message_attachments (user_message_id, attachment_id, attachment_order)
           VALUES ($1, $2, $3)`,
          [userMessageId, validatedAttachmentIds[i], i]
        );
      }
    }

    // Commit the transaction
    await client.query('COMMIT');

    // Write a signal file to wake up the agent's polling loop early
    try {
      const agentFolder = sanitizeFolderName(agentName);
      const signalPath = path.join(getChatspaceRoot(), agentFolder, 'agent_state', '.message_pending');
      fs.writeFileSync(signalPath, `from=user\ntime=${new Date().toISOString()}\n`);
    } catch (_signalErr) {
      // Non-critical: agent will still pick up the message on next poll cycle
    }

    res.status(201).json({
      messageId: userMessageId,
      timestamp: insertResult.rows[0].created_at.toISOString(),
      attachmentCount: validatedAttachmentIds.length
    });

  } catch (error) {
    // Rollback transaction on error
    await client.query('ROLLBACK');
    if (error instanceof chatThreadService.ChatThreadError) {
      return res.status(error.status).json({ error: { message: error.message } });
    }
    return handleDatabaseError(res, error, 'creating user message');
  } finally {
    // Release client back to pool
    client.release();
  }
});

/**
 * POST /api/user/messages/schedule
 * Store a text message for delivery at a future time. The scheduler moves it
 * into user_messages at the requested time, which also wakes the agent.
 */
router.post('/messages/schedule', async (req, res) => {
  const client = await getClient();
  let privateFenceTransaction = false;
  try {
    const userId = req.user.userId;
    const { agentId, content, encrypted, scheduledFor, runOverrides } = req.body;
    if (!isValidUUID(agentId)) return validationError(res, 'Invalid agent ID format');

    const contentValidation = validateMessageContent(content);
    if (!contentValidation.valid) return validationError(res, contentValidation.message);

    const when = new Date(scheduledFor);
    const now = Date.now();
    if (!scheduledFor || Number.isNaN(when.getTime()) || when.getTime() <= now) {
      return validationError(res, 'Choose a time in the future');
    }
    if (when.getTime() - now > 365 * 24 * 60 * 60 * 1000) {
      return validationError(res, 'Scheduled messages can be up to one year ahead');
    }

    const agent = await client.query(
      'SELECT agent_id, agent_name FROM agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );
    if (agent.rows.length === 0) {
      logUnauthorizedAccess(req, 'agent', agentId, 'User does not own this agent');
      return forbiddenError(res, 'You do not have access to this agent');
    }
    const overridesCheck = await resolveRunOverrides(agentId, agent.rows[0].agent_name, runOverrides);
    if (!overridesCheck.valid) return validationError(res, overridesCheck.message);

    if (process.env.FEATURE_IN_PLACE_AGENT_SHARING === 'true') {
      await client.query('BEGIN');
      privateFenceTransaction = true;
      await client.query('SELECT agent_id FROM agents WHERE agent_id=$1 AND user_id=$2 FOR UPDATE',[agentId,userId]);
      await chatThreadService.assertPrivateThreadWritable(client,agentId,userId);
    }

    const result = await client.query(
      `INSERT INTO scheduled_user_messages (user_id, agent_id, content, encrypted, scheduled_for, run_overrides)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING scheduled_message_id, scheduled_for`,
      [userId, agentId, content.trim(), encrypted === true, when, overridesCheck.value ? JSON.stringify(overridesCheck.value) : null]
    );
    if (privateFenceTransaction) { await client.query('COMMIT'); privateFenceTransaction = false; }
    return res.status(201).json({
      scheduledMessageId: result.rows[0].scheduled_message_id,
      scheduledFor: result.rows[0].scheduled_for.toISOString()
    });
  } catch (error) {
    if (privateFenceTransaction) await client.query('ROLLBACK').catch(() => {});
    if (error.status) return res.status(error.status).json({ error:{ message:error.message } });
    return handleDatabaseError(res, error, 'scheduling user message');
  } finally {
    client.release();
  }
});

// Pending scheduled messages can only be viewed or modified by their owner.
router.get('/messages/scheduled', async (req, res) => {
  try {
    const userId = req.user.userId;
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : null;
    if (agentId && !isValidUUID(agentId)) return validationError(res, 'Invalid agent ID format');
    const result = await query(
      `SELECT sm.scheduled_message_id, sm.agent_id, sm.content, sm.encrypted, sm.scheduled_for, sm.run_overrides, a.agent_name
       FROM scheduled_user_messages sm JOIN agents a ON a.agent_id = sm.agent_id
       WHERE sm.user_id = $1 AND sm.delivered_at IS NULL AND ($2 IS NULL OR sm.agent_id = $2)
       ORDER BY sm.scheduled_for ASC`, [userId, agentId]
    );
    return res.json({ scheduledMessages: result.rows.map((row) => ({
      scheduledMessageId: row.scheduled_message_id, agentId: row.agent_id, agentName: row.agent_name,
      content: row.content, encrypted: row.encrypted, scheduledFor: row.scheduled_for.toISOString(),
      runOverrides: row.run_overrides || null
    })) });
  } catch (error) { return handleDatabaseError(res, error, 'loading scheduled messages'); }
});

router.patch('/messages/scheduled/:scheduledMessageId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { scheduledMessageId } = req.params;
    const { content, encrypted, scheduledFor, runOverrides } = req.body;
    if (!isValidUUID(scheduledMessageId)) return validationError(res, 'Invalid scheduled message ID format');
    if (content === undefined && scheduledFor === undefined && runOverrides === undefined) return validationError(res, 'Provide a message or a new delivery time');
    const fields = [], params = [];
    if (content !== undefined) {
      const contentValidation = validateMessageContent(content);
      if (!contentValidation.valid) return validationError(res, contentValidation.message);
      params.push(content.trim(), encrypted === true);
      fields.push(`content = $${params.length - 1}`, `encrypted = $${params.length}`);
    }
    if (scheduledFor !== undefined) {
      const when = new Date(scheduledFor);
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) return validationError(res, 'Choose a time in the future');
      if (when.getTime() - Date.now() > 365 * 24 * 60 * 60 * 1000) return validationError(res, 'Scheduled messages can be up to one year ahead');
      params.push(when); fields.push(`scheduled_for = $${params.length}`);
    }
    if (runOverrides !== undefined) {
      const owner = await query(
        `SELECT a.agent_id, a.agent_name FROM scheduled_user_messages sm JOIN agents a ON a.agent_id = sm.agent_id
         WHERE sm.scheduled_message_id = $1 AND sm.user_id = $2 AND sm.delivered_at IS NULL`, [scheduledMessageId, userId]);
      if (owner.rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Scheduled message was not found or has already been sent' } });
      const overridesCheck = await resolveRunOverrides(owner.rows[0].agent_id, owner.rows[0].agent_name, runOverrides);
      if (!overridesCheck.valid) return validationError(res, overridesCheck.message);
      params.push(overridesCheck.value ? JSON.stringify(overridesCheck.value) : null);
      fields.push(`run_overrides = $${params.length}::jsonb`);
    }
    params.push(scheduledMessageId, userId);
    const result = await query(
      `UPDATE scheduled_user_messages SET ${fields.join(', ')}
       WHERE scheduled_message_id = $${params.length - 1} AND user_id = $${params.length} AND delivered_at IS NULL
       RETURNING scheduled_message_id, agent_id, content, encrypted, scheduled_for, run_overrides`, params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Scheduled message was not found or has already been sent' } });
    const row = result.rows[0];
    return res.json({ scheduledMessageId: row.scheduled_message_id, agentId: row.agent_id, content: row.content, encrypted: row.encrypted, scheduledFor: row.scheduled_for.toISOString(), runOverrides: row.run_overrides || null });
  } catch (error) { return handleDatabaseError(res, error, 'updating scheduled message'); }
});

router.delete('/messages/scheduled/:scheduledMessageId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { scheduledMessageId } = req.params;
    if (!isValidUUID(scheduledMessageId)) return validationError(res, 'Invalid scheduled message ID format');
    const result = await query('DELETE FROM scheduled_user_messages WHERE scheduled_message_id = $1 AND user_id = $2 AND delivered_at IS NULL RETURNING scheduled_message_id', [scheduledMessageId, userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Scheduled message was not found or has already been sent' } });
    return res.status(204).end();
  } catch (error) { return handleDatabaseError(res, error, 'cancelling scheduled message'); }
});

/**
 * POST /api/user/responses
 * Submit a response to an interactive question
 *
 * Request body:
 * - questionId: string (required) - UUID of the question message
 * - optionId: string (optional) - UUID of the selected option
 * - freeResponse: string (optional) - Free-form text response
 * - attachmentIds: string[] (optional) - Array of attachment UUIDs to attach to the response
 *
 * Note: At least one of optionId, freeResponse, or attachmentIds must be provided.
 *
 * Response: 201 Created
 * - responseId: string - UUID of the created response
 * - messageId: string - UUID of the created user message
 * - timestamp: string - ISO 8601 timestamp
 * - attachmentCount: number - Number of attachments attached
 */
router.post('/responses', async (req, res) => {
  const client = await getClient();

  try {
    const userId = req.user.userId;
    const { questionId, optionId, freeResponse, attachmentIds } = req.body;

    if (!questionId) {
      client.release();
      return validationError(res, 'Question ID is required');
    }

    if (!isValidUUID(questionId)) {
      client.release();
      return validationError(res, 'Invalid question ID format');
    }

    // Validate attachment IDs if provided
    const attachmentValidation = validateAttachmentIds(attachmentIds);
    if (!attachmentValidation.valid) {
      client.release();
      return validationError(res, attachmentValidation.message);
    }
    const validatedAttachmentIds = attachmentValidation.ids;
    const hasAttachments = validatedAttachmentIds.length > 0;

    // Start transaction
    await client.query('BEGIN');

    const questionResult = await client.query(
      `SELECT m.message_id, m.message_type, m.allow_free_response, a.agent_id
      FROM messages m
      JOIN agents a ON m.agent_id = a.agent_id
      WHERE m.message_id = $1 AND a.user_id = $2`,
      [questionId, userId]
    );

    if (questionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      logUnauthorizedAccess(req, 'question', questionId, 'Question does not belong to user');
      return forbiddenError(res, 'Question not found or you do not have access to it');
    }

    if (questionResult.rows[0].message_type !== 'question') {
      await client.query('ROLLBACK');
      client.release();
      return validationError(res, 'The specified message is not a question');
    }

    // Get the agent_id for creating a user_message and validating attachments
    const agentId = questionResult.rows[0].agent_id;
    if (process.env.FEATURE_IN_PLACE_AGENT_SHARING === 'true') {
      try {
        await client.query('SELECT agent_id FROM agents WHERE agent_id=$1 AND user_id=$2 FOR UPDATE', [agentId,userId]);
        await chatThreadService.assertPrivateThreadWritable(client,agentId,userId);
      } catch (error) {
        await client.query('ROLLBACK');
        client.release();
        if (error.status) return res.status(error.status).json({ error:{ message:error.message } });
        throw error;
      }
    }

    let validatedOptionId = null;
    let trimmedFreeResponse = null;

    if (optionId) {
      if (!isValidUUID(optionId)) {
        await client.query('ROLLBACK');
        client.release();
        return validationError(res, 'Invalid option ID format');
      }
      const optionResult = await client.query(
        'SELECT option_id FROM question_options WHERE option_id = $1 AND message_id = $2',
        [optionId, questionId]
      );

      if (optionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          error: {
            code: 'INVALID_OPTION_SELECTION',
            message: 'The selected option does not belong to this question'
          }
        });
      }
      validatedOptionId = optionId;
    }

    if (freeResponse !== undefined && freeResponse !== null) {
      if (typeof freeResponse !== 'string') {
        await client.query('ROLLBACK');
        client.release();
        return validationError(res, 'Free response must be text');
      }
      trimmedFreeResponse = freeResponse.trim();
      if (trimmedFreeResponse.length === 0) {
        trimmedFreeResponse = null;
      } else if (trimmedFreeResponse.length > 5000) {
        await client.query('ROLLBACK');
        client.release();
        return validationError(res, 'Free response exceeds maximum length of 5000 characters');
      }
    }

    // Require at least one form of response: option, text, or attachments
    if (!validatedOptionId && !trimmedFreeResponse && !hasAttachments) {
      await client.query('ROLLBACK');
      client.release();
      return validationError(res, 'Please provide a response (option, text, or attachments) before submitting.');
    }

    // Verify attachments exist, belong to this agent, and are not already attached to another message
    if (hasAttachments) {
      const attachmentCheck = await client.query(
        `SELECT attachment_id FROM attachments
         WHERE attachment_id = ANY($1)
         AND agent_id = $2`,
        [validatedAttachmentIds, agentId]
      );

      if (attachmentCheck.rows.length !== validatedAttachmentIds.length) {
        await client.query('ROLLBACK');
        client.release();
        return validationError(res, 'One or more attachment IDs are invalid or do not belong to this agent');
      }

      // Check if any attachments are already linked to a user message
      const alreadyLinked = await client.query(
        `SELECT attachment_id FROM user_message_attachments
         WHERE attachment_id = ANY($1)`,
        [validatedAttachmentIds]
      );

      if (alreadyLinked.rows.length > 0) {
        await client.query('ROLLBACK');
        client.release();
        return validationError(res, 'One or more attachments are already attached to another message');
      }
    }

    // We now allow free text for ALL questions, regardless of the flag
    // if (trimmedFreeResponse && !questionResult.rows[0].allow_free_response) {
    //   return validationError(res, 'This question does not accept free-form responses');
    // }

    const existingResponseResult = await client.query(
      'SELECT response_id FROM user_responses WHERE message_id = $1',
      [questionId]
    );

    if (existingResponseResult.rows.length > 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({
        error: {
          code: 'DUPLICATE_RESPONSE',
          message: 'You have already responded to this question'
        }
      });
    }

    // Get the option text if an option was selected
    let optionText = null;
    if (validatedOptionId) {
      const optionTextResult = await client.query(
        'SELECT option_text FROM question_options WHERE option_id = $1',
        [validatedOptionId]
      );
      if (optionTextResult.rows.length > 0) {
        optionText = optionTextResult.rows[0].option_text;
      }
    }

    // Build the message content for the user_message
    // This makes the response appear as a regular message in the chat
    // Content can be null if only attachments are provided
    let messageContent = null;
    if (optionText && trimmedFreeResponse) {
      messageContent = `Selected: "${optionText}"\n\n${trimmedFreeResponse}`;
    } else if (optionText) {
      messageContent = `Selected: "${optionText}"`;
    } else if (trimmedFreeResponse) {
      messageContent = trimmedFreeResponse;
    }

    const responseResult = await client.query(
      `INSERT INTO user_responses (message_id, option_id, free_response)
       VALUES ($1, $2, $3)
       RETURNING response_id`,
      [questionId, validatedOptionId, trimmedFreeResponse]
    );

    const responseId = responseResult.rows[0].response_id;

    // Also create a user_message so the response appears in the normal message flow
    // and the agent receives it via the standard message polling
    const userMessageResult = await client.query(
      `INSERT INTO user_messages (agent_id, content)
       VALUES ($1, $2)
       RETURNING user_message_id, created_at`,
      [agentId, messageContent]
    );

    const userMessageId = userMessageResult.rows[0].user_message_id;

    // Link attachments to the user message
    if (hasAttachments) {
      for (let i = 0; i < validatedAttachmentIds.length; i++) {
        await client.query(
          `INSERT INTO user_message_attachments (user_message_id, attachment_id, attachment_order)
           VALUES ($1, $2, $3)`,
          [userMessageId, validatedAttachmentIds[i], i]
        );
      }
    }

    // Commit the transaction
    await client.query('COMMIT');

    res.status(201).json({
      responseId: responseId,
      messageId: userMessageId,
      timestamp: userMessageResult.rows[0].created_at.toISOString(),
      attachmentCount: validatedAttachmentIds.length
    });

  } catch (error) {
    // Rollback transaction on error
    await client.query('ROLLBACK');
    if (error.code === '23505' && String(error.message || '').includes('user_responses')) {
      return res.status(409).json({
        error: {
          code: 'DUPLICATE_RESPONSE',
          message: 'You have already responded to this question'
        }
      });
    }
    return handleDatabaseError(res, error, 'creating response');
  } finally {
    // Release client back to pool
    client.release();
  }
});

/**
 * DELETE /api/user/agents/:agentId
 * Delete an agent and all associated messages
 * 
 * Path parameters:
 * - agentId: string - UUID of the agent to delete
 * 
 * Response: 200 OK
 * - success: boolean - Deletion status
 * - message: string - Confirmation message
 */
router.delete('/agents/:agentId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;

    // Validate UUID format
    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agent ID format');
    }

    // Validate user owns the agent
    const agentResult = await query(
      'SELECT agent_id, agent_name FROM agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      logUnauthorizedAccess(req, 'agent', agentId, 'User does not own this agent');
      return forbiddenError(res, 'Agent not found or you do not have access to it');
    }

    const agentName = agentResult.rows[0].agent_name;

    // Delete the agent (CASCADE will automatically delete all related data:
    // messages, question_options, user_responses, and user_messages)
    await query(
      'DELETE FROM agents WHERE agent_id = $1',
      [agentId]
    );

    res.status(200).json({
      success: true,
      message: `Agent "${agentName}" has been deleted successfully`
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'deleting agent');
  }
});

/**
 * DELETE /api/user/messages/:messageId
 * Delete a single message (agent message or user message)
 * 
 * Path parameters:
 * - messageId: string - UUID of the message to delete
 * 
 * Response: 200 OK
 * - success: boolean - Deletion status
 */
router.delete('/messages/:messageId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { messageId } = req.params;

    if (!isValidUUID(messageId)) {
      return validationError(res, 'Invalid message ID format');
    }

    // Try to find the message in `messages` table (agent messages)
    const agentMsgResult = await query(
      `SELECT m.message_id, a.user_id
       FROM messages m
       JOIN agents a ON m.agent_id = a.agent_id
       WHERE m.message_id = $1`,
      [messageId]
    );

    if (agentMsgResult.rows.length > 0) {
      if (agentMsgResult.rows[0].user_id !== userId) {
        logUnauthorizedAccess(req, 'message', messageId, 'User does not own this message');
        return forbiddenError(res, 'You do not have access to this message');
      }
      // Delete agent message (CASCADE removes question_options and user_responses)
      await query('DELETE FROM messages WHERE message_id = $1', [messageId]);
      return res.status(200).json({ success: true });
    }

    // Try to find in `user_messages` table
    const userMsgResult = await query(
      `SELECT um.user_message_id, a.user_id
       FROM user_messages um
       JOIN agents a ON um.agent_id = a.agent_id
       WHERE um.user_message_id = $1`,
      [messageId]
    );

    if (userMsgResult.rows.length > 0) {
      if (userMsgResult.rows[0].user_id !== userId) {
        logUnauthorizedAccess(req, 'user_message', messageId, 'User does not own this message');
        return forbiddenError(res, 'You do not have access to this message');
      }
      await query('DELETE FROM user_messages WHERE user_message_id = $1', [messageId]);
      return res.status(200).json({ success: true });
    }

    return validationError(res, 'Message not found');

  } catch (error) {
    return handleDatabaseError(res, error, 'deleting message');
  }
});

/**
 * DELETE /api/user/agents/:agentId/messages
 * Delete all messages for an agent (keep the agent)
 * 
 * Path parameters:
 * - agentId: string - UUID of the agent
 * 
 * Response: 200 OK
 * - success: boolean - Deletion status
 * - deletedCount: number - Total messages deleted
 */
router.delete('/agents/:agentId/messages', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;

    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agent ID format');
    }

    // Validate user owns the agent
    const agentResult = await query(
      'SELECT agent_id FROM agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      logUnauthorizedAccess(req, 'agent', agentId, 'User does not own this agent');
      return forbiddenError(res, 'Agent not found or you do not have access to it');
    }

    // Delete all agent messages (CASCADE removes question_options and user_responses)
    const agentMsgDel = await query('DELETE FROM messages WHERE agent_id = $1', [agentId]);
    // Delete all user messages
    const userMsgDel = await query('DELETE FROM user_messages WHERE agent_id = $1', [agentId]);

    const totalDeleted = (agentMsgDel.rowCount || 0) + (userMsgDel.rowCount || 0);

    res.status(200).json({
      success: true,
      deletedCount: totalDeleted
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'clearing conversation');
  }
});

/**
 * PUT /api/user/agents/:agentId/messages/hidden
 * Hide all messages for an agent from the agent context
 * 
 * Path parameters:
 * - agentId: string - UUID of the agent
 * 
 * Response: 200 OK
 * - success: boolean - Update status
 * - updatedCount: number - Total messages hidden
 */
router.put('/agents/:agentId/messages/hidden', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;
    // Default to true (hide) if not specified
    const hidden = req.body.hidden !== false;

    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agent ID format');
    }

    // Validate user owns the agent
    const agentResult = await query(
      'SELECT agent_id FROM agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      logUnauthorizedAccess(req, 'agent', agentId, 'User does not own this agent');
      return forbiddenError(res, 'Agent not found or you do not have access to it');
    }

    // Update agent messages
    const agentMsgUpdate = await query(
      'UPDATE messages SET hidden_from_agent = $2 WHERE agent_id = $1 AND hidden_from_agent != $2',
      [agentId, hidden]
    );

    // Update user messages
    const userMsgUpdate = await query(
      'UPDATE user_messages SET hidden_from_agent = $2 WHERE agent_id = $1 AND hidden_from_agent != $2',
      [agentId, hidden]
    );

    const totalUpdated = (agentMsgUpdate.rowCount || 0) + (userMsgUpdate.rowCount || 0);

    res.status(200).json({
      success: true,
      updatedCount: totalUpdated,
      hidden: hidden
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'updating message visibility');
  }
});

/**
 * POST /api/user/tts
 * Generate TTS audio for a given text
 * 
 * Request body:
 * - text: string (required) - Text to speak
 * 
 * Response: 200 OK
 * - audioUrl: string - URL to the generated audio file
 */
router.post('/tts', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return validationError(res, 'Text is required');
    }

    if (text.length > 500) {
      return validationError(res, 'Text exceeds maximum length of 500 characters');
    }

    const audioUrl = await ttsService.getAudioUrl(text);

    res.status(200).json({
      audioUrl: audioUrl
    });

  } catch (error) {
    console.error('TTS generation error:', error);
    return internalError(res, 'Failed to generate speech');
  }
});

/**
 * POST /api/user/attachments
 * Upload an encrypted image attachment
 *
 * Multipart form data fields:
 * - agentId: string (required) - UUID of the agent
 * - file: file (required) - Encrypted image file
 * - ivBase64: string (required) - AES-GCM initialization vector
 * - authTagBase64: string (required) - AES-GCM authentication tag
 * - contentType: string (required) - Original MIME type (image/png, image/jpeg, image/webp, image/gif)
 * - width: number (optional) - Image width in pixels
 * - height: number (optional) - Image height in pixels
 * - sha256: string (optional) - SHA-256 hash of plaintext for integrity
 *
 * Response: 201 Created
 * - attachmentId: string - UUID of the created attachment
 * - contentType: string - MIME type
 * - sizeBytes: number - Size of encrypted file
 * - width: number|null - Image width
 * - height: number|null - Image height
 * - encrypted: boolean - Always true
 * - encryption: object - Encryption metadata
 *   - alg: string - Algorithm (AES-GCM)
 *   - ivBase64: string - IV
 *   - tagBase64: string - Auth tag
 */
router.post('/attachments', uploadAttachment);

/**
 * GET /api/user/attachments/:attachmentId
 * Download an encrypted attachment
 *
 * Path parameters:
 * - attachmentId: string - UUID of the attachment
 *
 * Response: 200 OK
 * - Binary stream of encrypted ciphertext bytes
 * - Headers:
 *   - Content-Type: application/octet-stream
 *   - Content-Length: <size in bytes>
 *   - Cache-Control: private, max-age=3600
 *   - Content-Disposition: inline; filename="<sanitized_filename>" (if filename exists)
 *
 * Error responses:
 * - 400: Invalid attachment ID format
 * - 404: Attachment not found or user doesn't have access
 * - 500: Storage error
 */
router.get('/attachments/:attachmentId', downloadAttachment);

/**
 * POST /api/user/feedback
 * Submit anonymous feedback (no user_id stored)
 * Users must be logged in to access this endpoint, but feedback is completely anonymous
 *
 * Request body:
 * - kind: 'feedback' | 'love' (required) - Type of feedback
 * - message: string (required for kind='feedback') - Feedback message
 * - pageUrl: string (optional) - Current page URL
 *
 * Response: 201 Created
 * - success: boolean - Whether feedback was saved
 * - feedbackId: string - UUID of the created feedback (for reference only)
 */
router.post('/feedback', feedbackRateLimiter, parseFeedbackImage, async (req, res) => {
  try {
    const { kind, message, pageUrl } = req.body;

    // Validate kind
    if (!kind || !['feedback', 'love'].includes(kind)) {
      return validationError(res, 'Kind must be either "feedback" or "love"');
    }

    // Validate message for feedback kind
    if (kind === 'feedback') {
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return validationError(res, 'Message is required for feedback');
      }
      if (message.length > 5000) {
        return validationError(res, 'Message exceeds maximum length of 5000 characters');
      }
    }

    // Validate pageUrl if provided
    if (pageUrl && typeof pageUrl !== 'string') {
      return validationError(res, 'Invalid page URL');
    }

    const trimmedMessage = kind === 'feedback' ? message.trim() : null;
    const trimmedPageUrl = pageUrl ? pageUrl.substring(0, 2048) : null;
    const feedbackImage = req.file || null;
    // PRIVACY: user_agent intentionally not collected to ensure true anonymity
    // (user_agent + page_url + timestamp enables browser fingerprinting)

    // Insert into PostgreSQL (no user_id for anonymity)
    const result = await query(
      `INSERT INTO feedback (message, kind, page_url, image_data, image_content_type, image_filename)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING feedback_id, created_at`,
      [trimmedMessage, kind, trimmedPageUrl, feedbackImage?.buffer || null,
        feedbackImage?.mimetype || null, feedbackImage ? path.basename(feedbackImage.originalname || 'feedback-image') : null]
    );

    const feedbackId = result.rows[0].feedback_id;
    const createdAt = result.rows[0].created_at;

    // Append to CSV for easy export (create file with header if it doesn't exist)
    const csvDir = path.join(__dirname, '../../data');
    const csvPath = path.join(csvDir, 'feedback.csv');

    // Escape CSV fields (handle commas, quotes, newlines)
    const escapeCSV = (field) => {
      if (field === null || field === undefined) return '';
      const str = String(field);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const csvLine = [
      feedbackId,
      kind,
      escapeCSV(trimmedMessage),
      escapeCSV(trimmedPageUrl),
      createdAt.toISOString()
    ].join(',') + '\n';

    // Use mutex to serialize concurrent CSV writes and prevent race conditions
    await feedbackWriteMutex.acquire();
    try {
      // Ensure data directory exists (recursive: true is idempotent)
      await fsPromises.mkdir(csvDir, { recursive: true });

      // Try to create CSV with header atomically (fails if file exists)
      // PRIVACY: user_agent intentionally not included to ensure true anonymity
      try {
        const fileHandle = await fsPromises.open(csvPath, 'wx');
        await fileHandle.writeFile('feedback_id,kind,message,page_url,created_at\n');
        await fileHandle.close();
      } catch (err) {
        // EEXIST means file already exists, which is expected - ignore it
        if (err.code !== 'EEXIST') {
          throw err;
        }
      }

      // Append the feedback line
      await fsPromises.appendFile(csvPath, csvLine);
    } finally {
      feedbackWriteMutex.release();
    }

    res.status(201).json({
      success: true,
      feedbackId: feedbackId
    });

  } catch (error) {
    console.error('Feedback submission error:', error);
    return handleDatabaseError(res, error, 'submitting feedback');
  }
});

/**
 * GET /api/user/agents/:agentId/lineage
 * Returns lightweight lineage info: parent agent, direct children, and last poll time.
 */
router.get('/agents/:agentId/lineage', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;

    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agent ID format');
    }

    // Verify agent belongs to user and get its own metadata
    const agentRow = await query(
      `SELECT agent_id, agent_name, parent_agent_id, spawn_depth, last_seen_at
       FROM agents WHERE agent_id = $1 AND user_id = $2`,
      [agentId, userId]
    );

    if (agentRow.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Agent not found' } });
    }

    const agent = agentRow.rows[0];

    // Fetch parent agent info if exists
    let parent = null;
    if (agent.parent_agent_id) {
      const parentRow = await query(
        `SELECT agent_id, agent_name FROM agents WHERE agent_id = $1 AND user_id = $2`,
        [agent.parent_agent_id, userId]
      );
      if (parentRow.rows.length > 0) {
        parent = { agentId: parentRow.rows[0].agent_id, agentName: parentRow.rows[0].agent_name };
      }
    }

    // Fetch direct children
    const childrenRows = await query(
      `SELECT agent_id, agent_name FROM agents WHERE parent_agent_id = $1 AND user_id = $2 ORDER BY agent_name`,
      [agentId, userId]
    );
    const children = childrenRows.rows.map(r => ({ agentId: r.agent_id, agentName: r.agent_name }));

    return res.json({
      parent,
      children,
      lastPollAt: agent.last_seen_at ? agent.last_seen_at.toISOString() : null
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'fetching agent lineage');
  }
});

/**
 * POST /api/user/agents/:agentId/stop
 * Stop a running agent by setting DB flag, writing filesystem stop flag, and killing the process
 */
router.post('/agents/:agentId/stop', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;

    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agent ID format');
    }

    const agentResult = await query(
      'SELECT agent_id, agent_name FROM agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      logUnauthorizedAccess(req, 'agent', agentId, 'User does not own this agent');
      return forbiddenError(res, 'Agent not found or you do not have access to it');
    }

    const agent = agentResult.rows[0];
    const stopTimestamp = new Date();

    // 1. Set stop flag in database (works for remote agents via heartbeat)
    await query(
      'UPDATE agents SET stop_requested_at = $1 WHERE agent_id = $2',
      [stopTimestamp, agentId]
    );

    // 2. Write filesystem stop flag + kill process (works for local agents)
    let processKilled = false;
    let forceKilled = false;
    let stopFlagWritten = false;
    try {
      const agentFolder = sanitizeFolderName(agent.agent_name);
      const agentDir = findAgentLocalDir(agentFolder);
      if (agentDir) {
        const stateDir = path.join(agentDir, 'agent_state');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, '.stop_requested'), stopTimestamp.toISOString());
        stopFlagWritten = true;

        // Try to kill the process via PID file
        const pidPath = path.join(stateDir, '.agent_pid');
        const pid = readPidFromFile(pidPath);
        if (pid) {
          const killResult = terminateProcessWithEscalation(pid);
          processKilled = killResult.processKilled;
          forceKilled = killResult.forceKilled;
        }
      }
    } catch (e) {
      // Filesystem operations are best-effort; DB flag is the primary mechanism
    }

    res.status(200).json({
      success: true,
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      message: forceKilled
        ? 'Agent process force-killed by failsafe and stop flag set.'
        : processKilled
        ? 'Agent process killed and stop flag set.'
        : 'Stop requested. Agent will halt at next heartbeat.',
      processKilled,
      forceKilled,
      stopFlagWritten
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'stopping agent');
  }
});

/**
 * POST /api/user/agents/:agentId/archive
 * Archive an agent with all its messages
 */
router.post('/agents/:agentId/archive', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;
    const { reason } = req.body;

    // Validate UUID format
    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agent ID format');
    }

    // Archive the agent using archiveService
    const result = await archiveService.archiveAgent(userId, agentId, reason);

    res.status(200).json({
      success: true,
      archivedAgentId: result.archivedAgentId,
      messageCount: result.messageCount
    });

  } catch (error) {
    // Handle specific error cases
    if (error.message === 'Agent not found or access denied') {
      return res.status(404).json({
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'Agent not found or you do not have access to it'
        }
      });
    }

    if (error.message === 'Agent is already archived') {
      return res.status(409).json({
        error: {
          code: 'ALREADY_ARCHIVED',
          message: 'Agent is already archived'
        }
      });
    }

    return handleDatabaseError(res, error, 'archiving agent');
  }
});

/**
 * DELETE /api/user/agents/:agentId/archive
 * Unarchive (restore) an archived agent
 */
router.delete('/agents/:agentId/archive', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;

    // Validate UUID format
    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agent ID format');
    }

    // Look up archived_agent_id from agent_id
    const lookupResult = await query(
      'SELECT archived_agent_id FROM archived_agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (lookupResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'ARCHIVED_AGENT_NOT_FOUND',
          message: 'Archived agent not found or you do not have access to it'
        }
      });
    }

    const archivedAgentId = lookupResult.rows[0].archived_agent_id;

    // Unarchive the agent
    const result = await archiveService.unarchiveAgent(userId, archivedAgentId);

    res.status(200).json({
      success: true,
      agentId: result.agentId
    });

  } catch (error) {
    if (error.message === 'Archived agent not found or access denied') {
      return res.status(404).json({
        error: {
          code: 'ARCHIVED_AGENT_NOT_FOUND',
          message: 'Archived agent not found or you do not have access to it'
        }
      });
    }

    return handleDatabaseError(res, error, 'unarchiving agent');
  }
});

/**
 * POST /api/user/messages/:messageId/archive
 * Archive a single message (agent message or user message)
 */
router.post('/messages/:messageId/archive', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { messageId } = req.params;
    const { messageType, note } = req.body;

    // Validate UUID format
    if (!isValidUUID(messageId)) {
      return validationError(res, 'Invalid message ID format');
    }

    // Validate messageType
    if (!messageType || !['agent_message', 'user_message'].includes(messageType)) {
      return validationError(res, 'messageType must be either "agent_message" or "user_message"');
    }

    // Archive the message using archiveService
    const result = await archiveService.archiveMessage(userId, messageId, messageType, note);

    res.status(200).json({
      success: true,
      archivedMessageId: result.archivedMessageId
    });

  } catch (error) {
    if (error.message === 'Message not found or access denied') {
      return res.status(404).json({
        error: {
          code: 'MESSAGE_NOT_FOUND',
          message: 'Message not found or you do not have access to it'
        }
      });
    }

    if (error.message === 'Message is already archived') {
      return res.status(409).json({
        error: {
          code: 'ALREADY_ARCHIVED',
          message: 'Message is already archived'
        }
      });
    }

    if (error.message && error.message.includes('Invalid messageType')) {
      return validationError(res, error.message);
    }

    return handleDatabaseError(res, error, 'archiving message');
  }
});

/**
 * DELETE /api/user/messages/archive/:archivedMessageId
 * Unarchive (restore) an archived message
 */
router.delete('/messages/archive/:archivedMessageId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { archivedMessageId } = req.params;

    // Validate UUID format
    if (!isValidUUID(archivedMessageId)) {
      return validationError(res, 'Invalid archived message ID format');
    }

    // Unarchive the message
    const result = await archiveService.unarchiveMessage(userId, archivedMessageId);

    res.status(200).json({
      success: true,
      messageId: result.messageId
    });

  } catch (error) {
    if (error.message === 'Archived message not found or access denied') {
      return res.status(404).json({
        error: {
          code: 'ARCHIVED_MESSAGE_NOT_FOUND',
          message: 'Archived message not found or you do not have access to it'
        }
      });
    }

    if (error.message === 'Cannot restore message: associated agent no longer exists') {
      return res.status(404).json({
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'Cannot restore message: the associated agent no longer exists'
        }
      });
    }

    return handleDatabaseError(res, error, 'unarchiving message');
  }
});

/**
 * GET /api/user/archive/agents
 * Get list of archived agents with pagination
 */
router.get('/archive/agents', async (req, res) => {
  try {
    const userId = req.user.userId;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    // Validate pagination parameters
    if (limit < 1 || limit > 100) {
      return validationError(res, 'Limit must be between 1 and 100');
    }

    if (offset < 0) {
      return validationError(res, 'Offset must be non-negative');
    }

    // Get archived agents
    const result = await archiveService.getArchivedAgents(userId, { limit, offset });

    // Format response with camelCase
    const archivedAgents = result.archivedAgents.map(agent => ({
      archivedAgentId: agent.archived_agent_id,
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      agentType: agent.agent_type,
      totalMessages: agent.total_messages,
      archiveReason: agent.archive_reason,
      archivedAt: agent.archived_at.toISOString()
    }));

    res.status(200).json({
      archivedAgents,
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching archived agents');
  }
});

/**
 * GET /api/user/archive/agents/:archivedAgentId
 * Get details of a specific archived agent
 */
router.get('/archive/agents/:archivedAgentId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { archivedAgentId } = req.params;

    // Validate UUID format
    if (!isValidUUID(archivedAgentId)) {
      return validationError(res, 'Invalid archived agent ID format');
    }

    // Get archived agent details
    const agent = await archiveService.getArchivedAgentDetails(userId, archivedAgentId);

    res.status(200).json({
      archivedAgentId: agent.archived_agent_id,
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      agentType: agent.agent_type,
      totalMessages: agent.total_messages,
      archiveReason: agent.archive_reason,
      archivedAt: agent.archived_at.toISOString()
    });

  } catch (error) {
    if (error.message === 'Archived agent not found or access denied') {
      return res.status(404).json({
        error: {
          code: 'ARCHIVED_AGENT_NOT_FOUND',
          message: 'Archived agent not found or you do not have access to it'
        }
      });
    }

    return handleDatabaseError(res, error, 'fetching archived agent details');
  }
});

/**
 * GET /api/user/archive/messages
 * Get list of archived messages with optional agent filter and pagination
 */
router.get('/archive/messages', async (req, res) => {
  try {
    const userId = req.user.userId;
    const agentId = req.query.agentId || null;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    // Validate agentId if provided
    if (agentId && !isValidUUID(agentId)) {
      return validationError(res, 'Invalid agent ID format');
    }

    // Validate pagination parameters
    if (limit < 1 || limit > 100) {
      return validationError(res, 'Limit must be between 1 and 100');
    }

    if (offset < 0) {
      return validationError(res, 'Offset must be non-negative');
    }

    // Get archived messages
    const result = await archiveService.getArchivedMessages(userId, { agentId, limit, offset });

    // Format response with camelCase
    const archivedMessages = result.archivedMessages.map(msg => ({
      archivedMessageId: msg.archived_message_id,
      messageId: msg.message_id,
      userMessageId: msg.user_message_id,
      agentId: msg.agent_id,
      messageType: msg.message_type,
      contentSnapshot: msg.content_snapshot,
      hasAttachments: msg.has_attachments,
      archiveNote: msg.archive_note,
      archivedAt: msg.archived_at.toISOString()
    }));

    res.status(200).json({
      archivedMessages,
      total: result.total,
      limit: result.limit,
      offset: result.offset
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching archived messages');
  }
});

/**
 * DELETE /api/user/archive/:archivedAgentId
 * Permanently delete an archived agent and its archived messages
 */
router.delete('/archive/:archivedAgentId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { archivedAgentId } = req.params;

    // Validate UUID format
    if (!isValidUUID(archivedAgentId)) {
      return validationError(res, 'Invalid archived agent ID format');
    }

    // Verify ownership - user must own the archived agent
    const verifyResult = await query(
      'SELECT archived_agent_id FROM archived_agents WHERE archived_agent_id = $1 AND user_id = $2',
      [archivedAgentId, userId]
    );

    if (verifyResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'ARCHIVED_AGENT_NOT_FOUND',
          message: 'Archived agent not found or access denied'
        }
      });
    }

    // Use transaction to ensure both deletes succeed or fail together
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Delete archived messages first
      await client.query('DELETE FROM archived_messages WHERE archived_agent_id = $1', [archivedAgentId]);

      // Then delete the archived agent
      await client.query('DELETE FROM archived_agents WHERE archived_agent_id = $1', [archivedAgentId]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(200).json({
      success: true,
      message: 'Archived agent permanently deleted'
    });

  } catch (error) {
    console.error('Error permanently deleting archived agent:', error);
    return handleDatabaseError(res, error, 'deleting archived agent');
  }
});

// =============================================================================
// Inter-Agent Communication Endpoints (for dashboard visualization)
// =============================================================================

/**
 * GET /api/user/agent-messages
 * Get all agent-to-agent messages for the authenticated user's account
 * Used by the dashboard to render connection lines between communicating agents
 *
 * Query parameters:
 * - hours: number (optional, default: 24) - Only return messages from last N hours
 *
 * Response: 200 OK
 * - messages: array of message objects
 *   - messageId: string - UUID of the message
 *   - senderId: string - UUID of the sender agent
 *   - senderName: string - Name of the sender agent
 *   - recipientId: string - UUID of the recipient agent
 *   - recipientName: string - Name of the recipient agent
 *   - priority: number - Priority level (0, 1, or 2)
 *   - timestamp: string - ISO 8601 timestamp
 * - connections: array of unique agent pairs that communicated
 *   - agent1Id: string - UUID of first agent
 *   - agent1Name: string - Name of first agent
 *   - agent2Id: string - UUID of second agent
 *   - agent2Name: string - Name of second agent
 *   - messageCount: number - Number of messages between them
 *   - lastMessage: string - ISO timestamp of most recent message
 */
router.get('/agent-messages', async (req, res) => {
  try {
    const userId = req.user.userId;
    const hours = parseInt(req.query.hours, 10) || 24;

    // Validate hours parameter (max 7 days)
    if (hours < 1 || hours > 168) {
      return validationError(res, 'Hours must be between 1 and 168');
    }

    // Fetch agent-to-agent messages for this user's agents
    const result = await query(`
      SELECT 
        am.agent_message_id,
        am.sender_agent_id,
        sender.agent_name as sender_name,
        am.recipient_agent_id,
        recipient.agent_name as recipient_name,
        am.content,
        am.encrypted,
        am.priority,
        am.created_at
      FROM agent_messages am
      JOIN agents sender ON am.sender_agent_id = sender.agent_id
      JOIN agents recipient ON am.recipient_agent_id = recipient.agent_id
      WHERE sender.user_id = $1
        AND recipient.user_id = $1
        AND am.created_at > (NOW()::timestamp - INTERVAL '${hours} hours')
      ORDER BY am.created_at DESC
    `, [userId]);

    // Build connections summary (unique pairs of communicating agents)
    const connectionMap = new Map();

    for (const row of result.rows) {
      // Create a consistent key for the pair (smaller ID first)
      const ids = [row.sender_agent_id, row.recipient_agent_id].sort();
      const key = ids.join('-');

      if (!connectionMap.has(key)) {
        connectionMap.set(key, {
          agent1Id: ids[0],
          agent1Name: ids[0] === row.sender_agent_id ? row.sender_name : row.recipient_name,
          agent2Id: ids[1],
          agent2Name: ids[1] === row.sender_agent_id ? row.sender_name : row.recipient_name,
          messageCount: 0,
          lastMessage: null
        });
      }

      const conn = connectionMap.get(key);
      conn.messageCount++;
      if (!conn.lastMessage || new Date(row.created_at) > new Date(conn.lastMessage)) {
        conn.lastMessage = row.created_at.toISOString();
      }
    }

    res.status(200).json({
      messages: result.rows.map(row => ({
        messageId: row.agent_message_id,
        senderId: row.sender_agent_id,
        senderName: row.sender_name,
        recipientId: row.recipient_agent_id,
        recipientName: row.recipient_name,
        content: row.content,
        encrypted: row.encrypted === true,
        priority: row.priority,
        timestamp: row.created_at.toISOString()
      })),
      connections: Array.from(connectionMap.values())
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching agent messages');
  }
});

/**
 * POST /api/user/agents/:agentId/prepare-update
 * Returns the latest generated scripts so the browser can encrypt them before sending.
 * The browser will encrypt the payload with the user's password + salt and POST it
 * to /api/agent/update.
 *
 * Response: 200 OK
 * - version: string - Current agent CLI/runtime version
 * - files: { filename: content } - Latest file contents to be encrypted
 * - instructionsOnly: boolean
 */
router.post('/agents/:agentId/prepare-update', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;
    const { instructionsOnly } = req.body || {};

    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agentId format');
    }

    // Verify agent belongs to this user
    const agentResult = await query(
      'SELECT agent_id, agent_name FROM agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' }
      });
    }

    // Check if the user has encryption enabled
    const userResult = await query(
      'SELECT encryption_salt FROM users WHERE user_id = $1',
      [userId]
    );
    const hasEncryption = !!(userResult.rows[0] && userResult.rows[0].encryption_salt);

    const { buildUpdateManifest } = require('../utils/agentUpdater');
    const manifest = buildUpdateManifest(hasEncryption, {
      instructionsOnly: instructionsOnly === true
    });

    res.json({
      agentName: agentResult.rows[0].agent_name,
      ...manifest
    });
  } catch (error) {
    handleDatabaseError(res, error, 'preparing agent update');
  }
});

/**
 * POST /api/user/agents/:agentId/send-update
 * Store an encrypted update payload as a user_message for the agent to consume on its next poll.
 * The payload is encrypted client-side with the user's password + salt.
 *
 * Request body:
 * - encryptedPayload: string (required) - AES-GCM encrypted update manifest (iv:tag:ct format)
 * - version: string (optional) - Version label for logging
 *
 * Response: 201 Created
 */
router.post('/agents/:agentId/send-update', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;
    const { encryptedPayload, version } = req.body;

    if (!isValidUUID(agentId)) {
      return validationError(res, 'Invalid agentId format');
    }

    if (!encryptedPayload || typeof encryptedPayload !== 'string' || encryptedPayload.trim().length === 0) {
      return validationError(res, 'encryptedPayload is required');
    }

    // Verify format (iv:tag:ciphertext)
    const parts = encryptedPayload.split(':');
    if (parts.length !== 3) {
      return validationError(res, 'encryptedPayload must be in iv:authTag:ciphertext format');
    }

    // Verify agent belongs to this user
    const agentResult = await query(
      'SELECT agent_id, agent_name FROM agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' }
      });
    }

    // Store as a user_message with __AGENT_UPDATE__ prefix so the agent recognizes it
    const updateContent = `__AGENT_UPDATE__:${encryptedPayload}`;
    const messageResult = await query(
      `INSERT INTO user_messages (agent_id, content, encrypted)
       VALUES ($1, $2, $3)
       RETURNING user_message_id`,
      [agentId, updateContent, true]
    );

    res.status(201).json({
      status: 'update_queued',
      messageId: messageResult.rows[0].user_message_id,
      agentName: agentResult.rows[0].agent_name,
      version: version || 'unknown'
    });
  } catch (error) {
    handleDatabaseError(res, error, 'sending agent update');
  }
});

/**
 * GET /api/user/external-bots
 * List external bot connections (OpenClaw integration).
 */
router.get('/external-bots', async (req, res) => {
  try {
    if (!OPENCLAW_FEATURE_FLAG) {
      return res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'OpenClaw integration is disabled' } });
    }

    const userId = req.user.userId;
    const result = await query(
      `SELECT
         e.connection_id,
         e.provider,
         e.provider_bot_ref,
         e.status,
         e.last_handshake_at,
         e.last_error_code,
         e.last_error_at,
         e.created_at,
         e.updated_at,
         a.agent_id,
         a.agent_name,
         a.can_spawn,
         a.inter_agent_mode,
         a.last_seen_at
       FROM external_bot_connections e
       JOIN agents a ON e.agent_id = a.agent_id
       WHERE e.user_id = $1
       ORDER BY e.created_at DESC`,
      [userId]
    );

    res.json({
      connections: result.rows.map((row) => ({
        connectionId: row.connection_id,
        provider: row.provider,
        providerBotRef: row.provider_bot_ref,
        status: row.status,
        lastHandshakeAt: row.last_handshake_at ? row.last_handshake_at.toISOString() : null,
        lastErrorCode: row.last_error_code,
        lastErrorAt: row.last_error_at ? row.last_error_at.toISOString() : null,
        createdAt: row.created_at ? row.created_at.toISOString() : null,
        updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
        agent: {
          agentId: row.agent_id,
          name: row.agent_name,
          canSpawn: row.can_spawn === true,
          interAgentMode: row.inter_agent_mode || 'disabled',
          lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null
        }
      }))
    });
  } catch (error) {
    handleDatabaseError(res, error, 'listing external bots');
  }
});

/**
 * POST /api/user/external-agents/pairing-codes
 * Create a short-lived pairing code for agent-started external setup.
 */
router.post('/external-agents/pairing-codes', async (req, res) => {
  try {
    if (!OPENCLAW_FEATURE_FLAG) {
      return res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'External agent integration is disabled' } });
    }

    const userId = req.user.userId;
    const {
      provider = 'custom',
      agentName,
      providerBotRef,
      interAgentMode = 'groups',
      groupNames = [],
      canSpawn = false
    } = req.body || {};

    const normalizedProvider = normalizeExternalAgentProvider(provider);
    if (!normalizedProvider) {
      return validationError(res, 'provider must be lowercase letters, numbers, dashes, or underscores');
    }

    const agentValidation = validateMessageContent(agentName, { maxLength: 255, allowEmpty: false });
    if (!agentValidation.valid) {
      return validationError(res, 'agentName is required');
    }

    if (!VALID_INTER_AGENT_MODES.has(interAgentMode)) {
      return validationError(res, 'interAgentMode must be one of: disabled, listen_all, groups');
    }

    const normalizedGroupNames = normalizeGroupNames(groupNames);
    if (!normalizedGroupNames) {
      return validationError(res, 'groupNames must be an array');
    }

    const requestedAgentName = agentName.trim();
    const exists = await query(
      'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_name = $2',
      [userId, requestedAgentName]
    );
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: { code: 'AGENT_EXISTS', message: 'An agent with this name already exists' } });
    }

    const pairingCode = generateExternalAgentPairingCode();
    const pairingCodeHash = hashExternalAgentPairingCode(pairingCode);
    const expiresAt = new Date(Date.now() + EXTERNAL_AGENT_PAIRING_TTL_MS);

    const result = await query(
      `INSERT INTO external_agent_pairing_codes
        (user_id, provider, requested_agent_name, provider_bot_ref, inter_agent_mode,
         group_names_json, can_spawn, pairing_code_hash, display_code_prefix, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
       RETURNING pairing_id, provider, requested_agent_name, expires_at, created_at`,
      [
        userId,
        normalizedProvider,
        requestedAgentName,
        providerBotRef || null,
        interAgentMode,
        JSON.stringify(normalizedGroupNames),
        canSpawn === true,
        pairingCodeHash,
        pairingCode.slice(0, 5),
        expiresAt
      ]
    );

    const webBase = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      pairingId: result.rows[0].pairing_id,
      provider: result.rows[0].provider,
      agentName: result.rows[0].requested_agent_name,
      pairingCode,
      expiresAt: result.rows[0].expires_at ? result.rows[0].expires_at.toISOString() : expiresAt.toISOString(),
      instructions: [
        `Tell the external agent: "Use this Chat Space pairing code: ${pairingCode}"`,
        `The agent should redeem it with POST ${webBase}/api/agent/pairing/redeem.`,
        'Do not give the external agent your full API key.'
      ]
    });
  } catch (error) {
    handleDatabaseError(res, error, 'creating external agent pairing code');
  }
});

/**
 * POST /api/user/external-bots/openclaw
 * Onboard an existing OpenClaw bot as a first-class agent using a scoped token.
 */
router.post('/external-bots/openclaw', async (req, res) => {
  const client = await getClient();

  try {
    if (!OPENCLAW_FEATURE_FLAG) {
      client.release();
      return res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'OpenClaw integration is disabled' } });
    }

    const userId = req.user.userId;
    const {
      agentName,
      providerBotRef,
      interAgentMode = 'groups',
      groupNames = [],
      canSpawn = false,
      expiresAt = null
    } = req.body || {};

    const agentValidation = validateMessageContent(agentName, { maxLength: 255, allowEmpty: false });
    if (!agentValidation.valid) {
      client.release();
      return validationError(res, 'agentName is required');
    }

    if (!VALID_INTER_AGENT_MODES.has(interAgentMode)) {
      client.release();
      return validationError(res, 'interAgentMode must be one of: disabled, listen_all, groups');
    }

    if (!Array.isArray(groupNames)) {
      client.release();
      return validationError(res, 'groupNames must be an array');
    }

    await client.query('BEGIN');

    const exists = await client.query(
      'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_name = $2',
      [userId, agentName.trim()]
    );
    if (exists.rows.length > 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ error: { code: 'AGENT_EXISTS', message: 'An agent with this name already exists' } });
    }

    const nextPosResult = await client.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM agents WHERE user_id = $1',
      [userId]
    );
    const nextPosition = parseInt(nextPosResult.rows[0].next_pos, 10) || 1;

    const agentResult = await client.query(
      `INSERT INTO agents (user_id, agent_name, agent_type, position, can_spawn, inter_agent_mode)
       VALUES ($1, $2, 'standard', $3, $4, $5)
       RETURNING agent_id, agent_name, can_spawn, inter_agent_mode`,
      [userId, agentName.trim(), nextPosition, canSpawn === true, interAgentMode]
    );
    const agent = agentResult.rows[0];

    if (interAgentMode === 'groups' && groupNames.length > 0) {
      await syncAgentGroups(client, userId, agent.agent_id, groupNames);
    }

    const connectionResult = await client.query(
      `INSERT INTO external_bot_connections
         (user_id, agent_id, provider, provider_bot_ref, status)
       VALUES ($1, $2, 'openclaw', $3, 'pending_setup')
       RETURNING connection_id, status, created_at`,
      [userId, agent.agent_id, providerBotRef || null]
    );

    const scopes = getDefaultScopedScopes({ canSpawn: canSpawn === true });
    const credential = await issueScopedCredential({
      agentId: agent.agent_id,
      scopes,
      expiresAt: expiresAt || null,
      client
    });

    await client.query('COMMIT');
    client.release();

    const webBase = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const apiBase = `${webBase}/api`;
    const bootstrapPrompt = buildOpenClawBootstrap({
      agentName: agent.agent_name,
      token: credential.token,
      apiBase,
      webBase,
      canSpawn: canSpawn === true
    });

    res.status(201).json({
      connectionId: connectionResult.rows[0].connection_id,
      provider: 'openclaw',
      status: connectionResult.rows[0].status,
      createdAt: connectionResult.rows[0].created_at ? connectionResult.rows[0].created_at.toISOString() : null,
      agent: {
        agentId: agent.agent_id,
        name: agent.agent_name,
        canSpawn: agent.can_spawn === true,
        interAgentMode: agent.inter_agent_mode
      },
      credential: {
        credentialId: credential.credentialId,
        tokenPrefix: credential.tokenPrefix,
        scopes: credential.scopes,
        oneTimeAgentToken: credential.token
      },
      bootstrapPrompt
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackError) {
      // Ignore rollback errors
    }
    client.release();
    handleDatabaseError(res, error, 'creating OpenClaw connection');
  }
});

/**
 * PATCH /api/user/external-bots/:connectionId
 * Update external bot connection behavior.
 */
router.patch('/external-bots/:connectionId', async (req, res) => {
  const client = await getClient();

  try {
    if (!OPENCLAW_FEATURE_FLAG) {
      client.release();
      return res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'OpenClaw integration is disabled' } });
    }

    const userId = req.user.userId;
    const { connectionId } = req.params;
    const { interAgentMode, groupNames, canSpawn, providerBotRef, status } = req.body || {};

    if (!isValidUUID(connectionId)) {
      client.release();
      return validationError(res, 'Invalid connectionId format');
    }

    await client.query('BEGIN');

    const lookup = await client.query(
      `SELECT e.connection_id, e.agent_id, a.agent_name
       FROM external_bot_connections e
       JOIN agents a ON e.agent_id = a.agent_id
       WHERE e.connection_id = $1 AND e.user_id = $2`,
      [connectionId, userId]
    );

    if (lookup.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'External bot connection not found' } });
    }

    const agentId = lookup.rows[0].agent_id;
    const updates = [];
    const params = [];
    let idx = 1;

    if (providerBotRef !== undefined) {
      updates.push(`provider_bot_ref = $${idx++}`);
      params.push(providerBotRef || null);
    }
    if (status !== undefined) {
      updates.push(`status = $${idx++}`);
      params.push(status);
    }
    if (updates.length > 0) {
      updates.push(`updated_at = NOW()::timestamp`);
      params.push(connectionId, userId);
      await client.query(
        `UPDATE external_bot_connections
         SET ${updates.join(', ')}
         WHERE connection_id = $${idx++} AND user_id = $${idx}`,
        params
      );
    }

    if (interAgentMode !== undefined || canSpawn !== undefined) {
      const agentUpdates = [];
      const agentParams = [];
      let agentIdx = 1;

      if (interAgentMode !== undefined) {
        if (!VALID_INTER_AGENT_MODES.has(interAgentMode)) {
          await client.query('ROLLBACK');
          client.release();
          return validationError(res, 'interAgentMode must be one of: disabled, listen_all, groups');
        }
        agentUpdates.push(`inter_agent_mode = $${agentIdx++}`);
        agentParams.push(interAgentMode);
      }
      if (canSpawn !== undefined) {
        if (typeof canSpawn !== 'boolean') {
          await client.query('ROLLBACK');
          client.release();
          return validationError(res, 'canSpawn must be boolean');
        }
        agentUpdates.push(`can_spawn = $${agentIdx++}`);
        agentParams.push(canSpawn);
      }

      if (agentUpdates.length > 0) {
        agentParams.push(agentId);
        await client.query(
          `UPDATE agents SET ${agentUpdates.join(', ')} WHERE agent_id = $${agentIdx}`,
          agentParams
        );
      }
    }

    if (Array.isArray(groupNames)) {
      await syncAgentGroups(client, userId, agentId, groupNames);
    }

    await client.query('COMMIT');
    client.release();

    res.json({ success: true, connectionId });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackError) {
      // Ignore rollback errors
    }
    client.release();
    handleDatabaseError(res, error, 'updating external bot connection');
  }
});

/**
 * POST /api/user/external-bots/:connectionId/rotate-credential
 * Rotate scoped agent token for an external bot.
 */
router.post('/external-bots/:connectionId/rotate-credential', async (req, res) => {
  const client = await getClient();

  try {
    if (!OPENCLAW_FEATURE_FLAG) {
      client.release();
      return res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'OpenClaw integration is disabled' } });
    }

    const userId = req.user.userId;
    const { connectionId } = req.params;

    if (!isValidUUID(connectionId)) {
      client.release();
      return validationError(res, 'Invalid connectionId format');
    }

    await client.query('BEGIN');

    const lookup = await client.query(
      `SELECT a.agent_id, a.agent_name, a.can_spawn
       FROM external_bot_connections e
       JOIN agents a ON e.agent_id = a.agent_id
       WHERE e.connection_id = $1 AND e.user_id = $2`,
      [connectionId, userId]
    );

    if (lookup.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'External bot connection not found' } });
    }

    const agent = lookup.rows[0];
    await revokeActiveCredentials(agent.agent_id, { client });
    const credential = await issueScopedCredential({
      agentId: agent.agent_id,
      scopes: getDefaultScopedScopes({ canSpawn: agent.can_spawn === true }),
      client
    });

    await client.query(
      `UPDATE external_bot_connections
       SET updated_at = NOW()::timestamp, status = 'pending_setup'
       WHERE connection_id = $1`,
      [connectionId]
    );

    await client.query('COMMIT');
    client.release();

    res.json({
      success: true,
      connectionId,
      credential: {
        credentialId: credential.credentialId,
        tokenPrefix: credential.tokenPrefix,
        scopes: credential.scopes,
        oneTimeAgentToken: credential.token
      }
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackError) {
      // Ignore rollback errors
    }
    client.release();
    handleDatabaseError(res, error, 'rotating external bot credential');
  }
});

/**
 * POST /api/user/external-bots/:connectionId/verify
 * Mark a connection as verified after first successful handshake.
 */
router.post('/external-bots/:connectionId/verify', async (req, res) => {
  try {
    if (!OPENCLAW_FEATURE_FLAG) {
      return res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'OpenClaw integration is disabled' } });
    }

    const userId = req.user.userId;
    const { connectionId } = req.params;

    if (!isValidUUID(connectionId)) {
      return validationError(res, 'Invalid connectionId format');
    }

    const lookup = await query(
      `SELECT e.connection_id, e.agent_id
       FROM external_bot_connections e
       WHERE e.connection_id = $1 AND e.user_id = $2`,
      [connectionId, userId]
    );

    if (lookup.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'External bot connection not found' } });
    }

    const agentId = lookup.rows[0].agent_id;
    const authEvent = await query(
      `SELECT event_id FROM agent_auth_events
       WHERE agent_id = $1 AND event_type = 'auth_success'
       ORDER BY created_at DESC
       LIMIT 1`,
      [agentId]
    );

    if (authEvent.rows.length === 0) {
      return res.status(409).json({
        error: {
          code: 'HANDSHAKE_PENDING',
          message: 'No successful bot authentication recorded yet. Run the bootstrap handshake first.'
        }
      });
    }

    await query(
      `UPDATE external_bot_connections
       SET status = 'connected', last_handshake_at = NOW()::timestamp, updated_at = NOW()::timestamp
       WHERE connection_id = $1`,
      [connectionId]
    );

    res.json({ success: true, connectionId, status: 'connected' });
  } catch (error) {
    handleDatabaseError(res, error, 'verifying external bot connection');
  }
});

// ==========================================
// Group CRUD endpoints
// ==========================================

/**
 * GET /api/user/groups
 * List all groups for the authenticated user with member IDs
 */
router.get('/groups', async (req, res) => {
  try {
    const userId = req.user.userId;
    const groupsResult = await query(`
      SELECT g.group_id, g.group_name, g.description, g.created_at,
             COALESCE(json_agg(gm.agent_id) FILTER (WHERE gm.agent_id IS NOT NULL), '[]') as member_ids
      FROM agent_groups g
      LEFT JOIN agent_group_members gm ON g.group_id = gm.group_id
      WHERE g.user_id = $1
      GROUP BY g.group_id, g.group_name, g.description, g.created_at
      ORDER BY g.created_at ASC
    `, [userId]);

    res.json({
      groups: groupsResult.rows.map(r => ({
        groupId: r.group_id,
        groupName: r.group_name,
        description: r.description || '',
        memberIds: r.member_ids || [],
        createdAt: r.created_at ? r.created_at.toISOString() : null
      }))
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'fetching groups');
  }
});

/**
 * POST /api/user/groups
 * Create a new group with optional initial members
 */
router.post('/groups', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, description, memberIds } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return validationError(res, 'Group name is required');
    }
    if (name.trim().length > 100) {
      return validationError(res, 'Group name must be 100 characters or less');
    }

    const trimmedName = name.trim();
    const trimmedDesc = (description || '').trim().slice(0, 500);

    // Create group
    const result = await query(
      'INSERT INTO agent_groups (user_id, group_name, description) VALUES ($1, $2, $3) RETURNING group_id, group_name, description, created_at',
      [userId, trimmedName, trimmedDesc || null]
    );

    const group = result.rows[0];

    // Add initial members if provided
    if (Array.isArray(memberIds) && memberIds.length > 0) {
      const validMemberIds = memberIds.filter(id => isValidUUID(id));
      if (validMemberIds.length > 0) {
        // Verify ownership of agents
        const ownerCheck = await query(
          'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_id = ANY($2::uuid[])',
          [userId, validMemberIds]
        );
        const ownedIds = new Set(ownerCheck.rows.map(r => r.agent_id));
        const toInsert = validMemberIds.filter(id => ownedIds.has(id));

        if (toInsert.length > 0) {
          const values = toInsert.map((id, i) => `($1, $${i + 2})`).join(', ');
          const params = [group.group_id, ...toInsert];
          await query(
            `INSERT INTO agent_group_members (group_id, agent_id) VALUES ${values} ON CONFLICT DO NOTHING`,
            params
          );
        }
      }
    }

    // Fetch final member list
    const membersResult = await query(
      'SELECT agent_id FROM agent_group_members WHERE group_id = $1',
      [group.group_id]
    );

    res.status(201).json({
      group: {
        groupId: group.group_id,
        groupName: group.group_name,
        description: group.description || '',
        memberIds: membersResult.rows.map(r => r.agent_id),
        createdAt: group.created_at ? group.created_at.toISOString() : null
      }
    });
  } catch (error) {
    if (error.code === '23505') {
      return validationError(res, 'A group with that name already exists');
    }
    return handleDatabaseError(res, error, 'creating group');
  }
});

/**
 * PUT /api/user/groups/:groupId
 * Update group name and/or description
 */
router.put('/groups/:groupId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId } = req.params;
    const { name, description } = req.body || {};

    if (!isValidUUID(groupId)) {
      return validationError(res, 'Invalid group ID');
    }

    // Verify ownership
    const existing = await query(
      'SELECT group_id FROM agent_groups WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );
    if (existing.rows.length === 0) {
      return forbiddenError(res, 'Group not found or access denied');
    }

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return validationError(res, 'Group name cannot be empty');
      }
      if (name.trim().length > 100) {
        return validationError(res, 'Group name must be 100 characters or less');
      }
      updates.push(`group_name = $${paramIndex++}`);
      params.push(name.trim());
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push((description || '').trim().slice(0, 500) || null);
    }

    if (updates.length === 0) {
      return validationError(res, 'No fields to update');
    }

    params.push(groupId);
    const result = await query(
      `UPDATE agent_groups SET ${updates.join(', ')} WHERE group_id = $${paramIndex} RETURNING group_id, group_name, description, created_at`,
      params
    );

    const group = result.rows[0];
    const membersResult = await query(
      'SELECT agent_id FROM agent_group_members WHERE group_id = $1',
      [groupId]
    );

    res.json({
      group: {
        groupId: group.group_id,
        groupName: group.group_name,
        description: group.description || '',
        memberIds: membersResult.rows.map(r => r.agent_id),
        createdAt: group.created_at ? group.created_at.toISOString() : null
      }
    });
  } catch (error) {
    if (error.code === '23505') {
      return validationError(res, 'A group with that name already exists');
    }
    return handleDatabaseError(res, error, 'updating group');
  }
});

/**
 * DELETE /api/user/groups/:groupId
 * Delete a group (members removed via CASCADE)
 */
router.delete('/groups/:groupId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId } = req.params;

    if (!isValidUUID(groupId)) {
      return validationError(res, 'Invalid group ID');
    }

    const result = await query(
      'DELETE FROM agent_groups WHERE group_id = $1 AND user_id = $2 RETURNING group_id',
      [groupId, userId]
    );

    if (result.rows.length === 0) {
      return forbiddenError(res, 'Group not found or access denied');
    }

    res.json({ success: true });
  } catch (error) {
    return handleDatabaseError(res, error, 'deleting group');
  }
});

/**
 * POST /api/user/groups/:groupId/members
 * Add one or more agents to a group
 */
router.post('/groups/:groupId/members', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId } = req.params;
    const { agentIds } = req.body || {};

    if (!isValidUUID(groupId)) {
      return validationError(res, 'Invalid group ID');
    }
    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      return validationError(res, 'agentIds array is required');
    }

    const validIds = agentIds.filter(id => isValidUUID(id));
    if (validIds.length === 0) {
      return validationError(res, 'No valid agent IDs provided');
    }

    // Verify group ownership
    const groupCheck = await query(
      'SELECT group_id FROM agent_groups WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );
    if (groupCheck.rows.length === 0) {
      return forbiddenError(res, 'Group not found or access denied');
    }

    // Verify agent ownership
    const ownerCheck = await query(
      'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_id = ANY($2::uuid[])',
      [userId, validIds]
    );
    const ownedIds = ownerCheck.rows.map(r => r.agent_id);

    if (ownedIds.length > 0) {
      const values = ownedIds.map((id, i) => `($1, $${i + 2})`).join(', ');
      const params = [groupId, ...ownedIds];
      await query(
        `INSERT INTO agent_group_members (group_id, agent_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        params
      );
    }

    // Return updated member list
    const membersResult = await query(
      'SELECT agent_id FROM agent_group_members WHERE group_id = $1',
      [groupId]
    );

    res.json({
      memberIds: membersResult.rows.map(r => r.agent_id)
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'adding group members');
  }
});

/**
 * DELETE /api/user/groups/:groupId/members/:agentId
 * Remove a single agent from a group
 */
router.delete('/groups/:groupId/members/:agentId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId, agentId } = req.params;

    if (!isValidUUID(groupId) || !isValidUUID(agentId)) {
      return validationError(res, 'Invalid group or agent ID');
    }

    // Verify group ownership
    const groupCheck = await query(
      'SELECT group_id FROM agent_groups WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );
    if (groupCheck.rows.length === 0) {
      return forbiddenError(res, 'Group not found or access denied');
    }

    await query(
      'DELETE FROM agent_group_members WHERE group_id = $1 AND agent_id = $2',
      [groupId, agentId]
    );

    res.json({ success: true });
  } catch (error) {
    return handleDatabaseError(res, error, 'removing group member');
  }
});

module.exports = router;
