/**
 * Agent API Routes
 * RESTful API endpoints for AI agents to send messages and poll for responses
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireApiKey } = require('../middleware/authMiddleware');
const {
  agentApiRateLimiter,
  agentPollingRateLimiter,
  agentMessageIngressRateLimiter,
  getUsageStatus,
  resolveClientIdentifier,
  resolveAgentName
} = require('../middleware/rateLimitMiddleware');
const { query, getClient } = require('../db/connection');
const chatThreadService = require('../shared/chatThreadService');
const {
  validateMessageContent,
  validateAttachmentIds,
  validatePriority,
  validateOptionsArray,
  validateAgentName,
  validateBoolean,
  validateTimestamp,
  formatTimestampForDatabase,
  validateFreeResponseHint,
  isValidUUID
} = require('../utils/validation');
const { validationError, handleDatabaseError, internalError } = require('../utils/errorHandler');
const { uploadAttachment, downloadAttachment } = require('../controllers/agentAttachmentController');
const { MAX_IMAGE_BYTES, ENABLE_GENERAL_FILE_UPLOADS } = require('../controllers/userAttachmentController');
const { generateMainCLIScript } = require('../utils/apiGuideGenerator');
const { normalizeCliVersion, parseCliVersion } = require('../utils/agentCliVersion');
const { isAgentArchived } = require('../services/archiveService');
const { spawnAgent, selfTerminate, getLineage, getChildren, SpawnError, sanitizeFolderName, getChatspaceRoot } = require('../services/agentSpawnService');
const { chiefOfStaffOnly } = require('../middleware/chiefOfStaffOnly');
const chiefOfStaffService = require('../services/chiefOfStaffService');
const {
  DEFAULT_AGENT_API_CONFIG,
  loadAgentRuntimeState,
  persistAgentRuntimeState,
  syncRuntimeStateToFilesystem
} = require('../services/agentRuntimeConfigService');
const { getProviderModelCatalog, getProviderModels, updateProviderModelsForUser, SUPPORTED_PROVIDERS } = require('../utils/modelCatalog');
const { readPidFromFile, terminateProcessWithEscalation } = require('../utils/agentStopUtils');
const { issueScopedCredential } = require('../services/agentCredentialService');
const fs = require('fs');
const path = require('path');

const SHOULD_USE_TEST_DB_BULK_FALLBACK = process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;
const { getEncryptionParams, encryptMessage } = require('../utils/encryptionHelper');

function getPollAdvice(req, hadPayload = false) {
  const advice = req.res && req.res.locals ? req.res.locals.pollAdvice : null;
  if (!advice) return undefined;
  return {
    ...advice,
    reason: hadPayload ? 'payload' : advice.reason
  };
}

let agentMessageSchemaCache = {
  expiresAt: 0,
  hasMessagesRunCommand: true,
  hasMessagesClientId: true
};

const RICH_HTML_TEMPLATE_TOKEN = /_{0,2}REPLACE_WITH_[A-Z0-9_]+_{0,2}/;
const RICH_HTML_VERBATIM_STUBS = [
  /"title"\s*:\s*"Your Title"/, // old agent-runner.sh Option B example
  /"html"\s*:\s*"<div>Your HTML here<\/div>"/, // old agent-runner.sh Option B example
  /"title"\s*:\s*"My Report"/, // old agent-runner.sh Option A example used verbatim
];
const RICH_HTML_MESSAGE_TYPE = /"type"\s*:\s*"rich_(html|interactive)"/;
const VALID_INTER_AGENT_MODES = new Set(['disabled', 'listen_all', 'groups']);

function hashExternalAgentPairingCode(pairingCode) {
  return crypto
    .createHash('sha256')
    .update(String(pairingCode || '').trim().toUpperCase())
    .digest('hex');
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
    'agent.history.read',
    'agent.usage.read'
  ];

  if (canSpawn === true) {
    scopes.push('agent.spawn.write');
  }

  return scopes;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

async function syncAgentGroups(client, userId, agentId, groupNames) {
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

async function loadAgentMessageSchema(dbClient) {
  const now = Date.now();
  if (agentMessageSchemaCache.expiresAt > now) return agentMessageSchemaCache;
  try {
    const result = await (dbClient || { query }).query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='messages'
        AND column_name IN ('run_command','client_message_id')`);
    const columns = new Set(result.rows.map(row => row.column_name));
    agentMessageSchemaCache = {
      hasMessagesRunCommand: columns.has('run_command'),
      hasMessagesClientId: columns.has('client_message_id'),
      expiresAt: now + 60_000
    };
  } catch (_error) {
    agentMessageSchemaCache = {
      hasMessagesRunCommand: false,
      hasMessagesClientId: false,
      expiresAt: now + 5_000
    };
  }
  return agentMessageSchemaCache;
}
async function hasMessagesRunCommandColumn(dbClient) {
  return (await loadAgentMessageSchema(dbClient)).hasMessagesRunCommand;
}
async function hasMessagesClientIdColumn(dbClient) {
  return (await loadAgentMessageSchema(dbClient)).hasMessagesClientId;
}

// =============================================================================
// Public endpoints (no authentication required)
// =============================================================================

/**
 * GET /api/agent/connect-guide
 * Machine-readable onboarding guide for external bots (e.g. OpenClaw)
 * 
 * No authentication required — this is a public discovery endpoint.
 * Bots read this to learn how to connect to ChatMCPSpace.
 * 
 * Response: 200 OK (application/json)
 * Returns step-by-step instructions, endpoint catalog, and encryption spec.
 */
router.get('/connect-guide', (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const encryptionParams = getEncryptionParams();

  res.json({
    service: 'ChatMCPSpace',
    version: '1.0',
    baseUrl,
    description: 'Agent communication hub with end-to-end encryption. The server never sees message plaintext.',

    externalAgentBridge: {
      protocolVersion: 1,
      capabilities: {
        history: 'Explicit history command retrieves this agent\'s visible conversation and attachment metadata; new work retains bounded context.',
        incomingImages: 'Inline image content for compatible runtimes, up to 8 MiB per image.',
        incomingFiles: 'Decrypted local files and metadata; EXTERNAL_AGENT_SHARED_FILES=true requires matching filesystem access for the runtime.',
        outgoingFiles: 'send --file PATH attaches encrypted files to the user conversation.',
        peerAttachments: false,
        maxAttachmentBytes: MAX_IMAGE_BYTES,
        generalFileUploadsEnabled: ENABLE_GENERAL_FILE_UPLOADS,
        attachmentScopes: ['agent.attachments.read', 'agent.attachments.write']
      },
      providers: ['hermes', 'openclaw', 'pi', 'custom'],
      runtimeOwnership: 'External agents keep their own runtime, tools, memory, and permissions.',
      script: `${baseUrl}/api/agent/external-bridge.js`,
      documentation: `${baseUrl}/api/agent/external-bridge-guide`,
      attachmentUpload: 'POST /api/agent/attachments (encrypted multipart file)',
      attachmentDownload: 'GET /api/agent/attachments/:attachmentId (encrypted bytes)',
      agentInstructions: `${baseUrl}/api/agent/connection-instructions`,
      userInstructions: `${baseUrl}/api/agent/connection-help`,
      continuousOperation: 'Run one external-agent-bridge.js run process per identity; keep it alive through a local process manager. Polling does not invoke the runtime while idle. Inspect uncertain executions before restarting.',
      auth: 'X-Agent-Token (bound to the paired agent); X-Agent-Name is optional for scoped tokens.',
      userInbox: 'GET /api/agent/responses?markRead=false',
      userAck: 'POST /api/agent/responses/ack { messageId, responseType: "text" | "response" }',
      peerInbox: 'GET /api/agent/messages/direct?markRead=false',
      peerAck: 'POST /api/agent/messages/direct/ack { messageId }',
      peerSend: 'POST /api/agent/messages/direct { toAgentName, content, encrypted: true, clientMessageId }',
      discovery: 'GET /api/agent/discover',
      heartbeat: 'POST /api/agent/heartbeat { agentName, isWorking }',
      delivery: 'Poll without marking read, persist encrypted reply and its stable UUID, send, then acknowledge. Legacy polling still consumes on delivery.',
      coordination: 'A user-chosen central agent can direct connected agents through permitted direct messages. Remote process control is not implied.',
      replyEnvelope: 'Encrypted peer replies may contain { type: "chatmcpspace.bridge_reply.v1", inReplyTo, content }. Treat these as results; do not automatically reply to a reply.'
    },

    preferredOnboarding: {
      mode: 'agent_started_pairing',
      description: 'Preferred setup: the user asks the external agent in simple free text to connect to ChatMCP, then this guide tells the agent how to lead the user through approval and redeem a short-lived pairing code. Never ask for the user full API key for this flow.',
      userPromptExample: `Connect to ChatMCP at ${baseUrl} and guide me through what needs to be done.`,
      agentSetupGoal: 'After seeing the user prompt, read this guide and /api/agent/connection-instructions, guide approval and local pairing, configure the existing runtime, keep a persistent listener running, and verify user and permitted peer replies through ChatMCPSpace.',
      approvalUrlTemplate: `${baseUrl}/settings/external-agents/approve?provider={provider}&agentName={url_encoded_agent_name}`,
      userMayBeAskedFor: [
        'Opening the approval link in a browser',
        'Signing in with Google or the normal site login if the site asks',
        'Clicking Approve on the ChatMCPSpace approval page',
        'Copying the short-lived pairing code back to the external agent',
        'Providing local-only encryption unlock material if E2E setup requires it'
      ],
      userMustNotBeAskedFor: [
        'Full ChatMCPSpace account API key during the preferred pairing flow',
        'Google password or OAuth tokens',
        'Raw database credentials',
        'Any secret not explicitly required by the approval page or local encryption unlock'
      ],
      redeem: {
        method: 'POST',
        path: '/api/agent/pairing/redeem',
        auth: 'No API key. Requires short-lived pairingCode from authenticated approval page.',
        body: {
          pairingCode: '{pairing_code_from_user}',
          providerBotRef: '{optional_provider_side_identifier}'
        },
        responseFields: {
          agentToken: 'One-time-visible scoped token. Store securely and send as X-Agent-Token.',
          agent: 'Created agent identity',
          encryptionSalt: 'Base64 per-user salt for local E2E key derivation',
          encryptionParams: 'Algorithm parameters for key derivation and encryption'
        }
      }
    },

    onboarding: {
      description: 'Legacy fallback setup. Prefer preferredOnboarding.agent_started_pairing when possible.',
      steps: [
        {
          step: 1,
          action: 'ask_user',
          prompt: `Please provide your ChatMCPSpace API key. You can find it at ${baseUrl}/settings — if you don't have an account, register at ${baseUrl}/register`,
          field: 'api_key',
          format: 'uuid',
          required: true
        },
        {
          step: 2,
          action: 'call_api',
          method: 'POST',
          path: '/api/agent/register',
          headers: { 'X-API-Key': '{api_key}', 'Content-Type': 'application/json' },
          body: { agentName: '{bot_name}' },
          description: 'Register yourself as an agent. Returns your encryption salt and params. This call is idempotent — calling it again with the same name returns the existing agent.',
          responseFields: {
            agentId: 'UUID — your unique agent identifier',
            agentName: 'Your registered agent name',
            encryptionSalt: 'Base64 — per-user salt for E2E encryption key derivation',
            encryptionParams: 'Algorithm parameters for key derivation and encryption'
          }
        },
        {
          step: 3,
          action: 'ask_user',
          prompt: 'Please enter your ChatMCPSpace account password. This is needed to derive the E2E encryption key. It stays on your machine and is NEVER sent to the server.',
          field: 'password',
          sensitive: true,
          required: true
        },
        {
          step: 4,
          action: 'derive_key',
          description: 'Derive the encryption key locally: key = PBKDF2(password, encryptionSalt). Store the derived key or password securely (e.g. environment variable). Remove the password from memory after derivation.',
          algorithm: encryptionParams.algorithm,
          params: {
            hash: encryptionParams.hash,
            iterations: encryptionParams.iterations,
            keyLength: encryptionParams.keyLength
          }
        },
        {
          step: 5,
          action: 'ready',
          description: 'You are now connected! Use the endpoints below to send and receive encrypted messages.'
        }
      ]
    },

    endpoints: {
      sendMessage: {
        method: 'POST',
        path: '/api/agent/messages',
        auth: 'X-Agent-Token (preferred), or legacy X-API-Key',
        description: 'Send a message from the bot to the user',
        body: {
          agentName: { type: 'string', required: true, description: 'Your registered agent name' },
          content: { type: 'string', required: true, description: 'Encrypted message content (see encryption section)' },
          encrypted: { type: 'boolean', required: true, value: true, description: 'Must be true — messages must be encrypted' },
          priority: { type: 'integer', required: false, description: '0=normal, 1=needs attention, 2=urgent', default: 0 }
        },
        response: {
          messageId: 'UUID of created message',
          newMessages: 'Legacy empty array; use getResponses to receive user messages'
        }
      },

      getMessageHistory: {
        method: 'GET',
        path: '/api/agent/messages/history',
        auth: 'X-Agent-Token (preferred), or legacy X-API-Key',
        description: 'Get full conversation history (agent messages, user messages, responses)',
        params: {
          agentName: { type: 'string', required: true, description: 'Your agent name' }
        }
      },

      checkNewMessages: {
        method: 'GET',
        path: '/api/agent/responses?markRead=false',
        auth: 'X-Agent-Token (preferred), or legacy X-API-Key',
        description: 'Read pending user messages without consuming them. Acknowledge each after its response has been delivered.'
      },

      sendQuestion: {
        method: 'POST',
        path: '/api/agent/questions',
        auth: 'X-Agent-Token (preferred), or legacy X-API-Key',
        description: 'Send an interactive question with multiple choice options',
        body: {
          agentName: { type: 'string', required: true },
          content: { type: 'string', required: true, description: 'Encrypted question text' },
          encrypted: { type: 'boolean', required: true, value: true },
          options: { type: 'array', required: false, description: 'Array of { text, benefits, downsides, isDefault }' },
          allowFreeResponse: { type: 'boolean', required: false, default: false }
        }
      },

      getResponses: {
        method: 'GET',
        path: '/api/agent/responses',
        auth: 'X-Agent-Token (preferred), or legacy X-API-Key',
        description: 'Poll for user messages and replies to questions. markRead=false requires explicit acknowledgement.',
        params: {
          agentName: { type: 'string', required: false },
          since: { type: 'string', required: false, description: 'ISO 8601 timestamp — only return responses after this time' }
        }
      },

      registerAgent: {
        method: 'POST',
        path: '/api/agent/register',
        auth: 'X-API-Key header (legacy registration only)',
        description: 'Register a new agent (idempotent)',
        body: {
          agentName: { type: 'string', required: true, description: 'Desired agent name' }
        }
      }
    },

    encryption: {
      required: true,
      description: 'All message content must be encrypted client-side before sending. The server never sees plaintext.',
      algorithm: encryptionParams.cipherAlgorithm,
      keyDerivation: {
        algorithm: encryptionParams.algorithm,
        hash: encryptionParams.hash,
        iterations: encryptionParams.iterations,
        keyLengthBits: encryptionParams.keyLength,
        input: 'PBKDF2(user_password, encryptionSalt)'
      },
      cipher: {
        algorithm: encryptionParams.cipherAlgorithm,
        ivLengthBytes: encryptionParams.ivLength,
        tagLengthBits: encryptionParams.tagLength
      },
      format: 'iv:authTag:ciphertext (all base64 encoded, colon-separated)',
      example: 'Base64(iv):Base64(authTag):Base64(ciphertext)'
    }
  });
});

// Fixed public artifacts let an agent on another machine install the connector
// advertised by the guide. No credentials or user-specific source are embedded.
router.get('/sharing-status', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    enabled: process.env.FEATURE_SHARED_CONVERSATIONS === 'true',
    guestEnabled: process.env.FEATURE_SHARED_CONVERSATIONS === 'true' && process.env.FEATURE_GUEST_SHARING === 'true',
    executionMode: 'trusted'
  });
});
router.get('/shared-runner.js', (_req, res) => {
  res.type('application/javascript').send(require('../shared/bundle').generateSharedRunnerBundle());
});
router.get('/shared-guide', (_req, res) => res.type('text/plain').sendFile(path.join(__dirname, '../../docs/SHARED_CONVERSATIONS.md')));
router.get('/external-bridge.js', (_req, res) => {
  res.download(path.join(__dirname, '../../scripts/external-agent-bridge.js'), 'external-agent-bridge.js');
});
router.get('/external-bridge-guide', (_req, res) => {
  res.type('text/plain').sendFile(path.join(__dirname, '../../docs/EXTERNAL_AGENT_BRIDGE.md'));
});
router.get('/connection-instructions', (_req, res) => {
  res.type('text/plain').sendFile(path.join(__dirname, '../../docs/EXTERNAL_AGENT_INSTRUCTIONS.md'));
});
router.get('/connection-help', (_req, res) => {
  res.type('text/plain').sendFile(path.join(__dirname, '../../docs/CONNECT_YOUR_AGENT.md'));
});

/**
 * POST /api/agent/pairing/redeem
 * Redeem a user-approved short-lived pairing code for a scoped agent token.
 */
router.post('/pairing/redeem', async (req, res) => {
  const client = await getClient();

  try {
    const { pairingCode, providerBotRef } = req.body || {};
    if (!pairingCode || typeof pairingCode !== 'string') {
      client.release();
      return validationError(res, 'pairingCode is required');
    }

    const pairingCodeHash = hashExternalAgentPairingCode(pairingCode);

    await client.query('BEGIN');

    const pairingResult = await client.query(
      `SELECT
         pairing_id,
         user_id,
         provider,
         requested_agent_name,
         provider_bot_ref,
         inter_agent_mode,
         group_names_json,
         can_spawn,
         expires_at,
         redeemed_at
       FROM external_agent_pairing_codes
       WHERE pairing_code_hash = $1
       LIMIT 1`,
      [pairingCodeHash]
    );

    if (pairingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: { code: 'PAIRING_CODE_NOT_FOUND', message: 'Pairing code was not found or has expired' } });
    }

    const pairing = pairingResult.rows[0];
    const expiresAt = pairing.expires_at instanceof Date ? pairing.expires_at : new Date(pairing.expires_at);
    if (pairing.redeemed_at || expiresAt.getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ error: { code: 'PAIRING_CODE_NOT_USABLE', message: 'Pairing code has already been used or has expired' } });
    }

    if (!VALID_INTER_AGENT_MODES.has(pairing.inter_agent_mode)) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: { code: 'INVALID_PAIRING_CONFIG', message: 'Pairing code has invalid inter-agent configuration' } });
    }

    const existingAgent = await client.query(
      'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_name = $2',
      [pairing.user_id, pairing.requested_agent_name]
    );
    if (existingAgent.rows.length > 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ error: { code: 'AGENT_EXISTS', message: 'An agent with this name already exists' } });
    }

    const nextPosResult = await client.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM agents WHERE user_id = $1',
      [pairing.user_id]
    );
    const nextPosition = parseInt(nextPosResult.rows[0].next_pos, 10) || 1;

    const agentResult = await client.query(
      `INSERT INTO agents (user_id, agent_name, agent_type, position, can_spawn, inter_agent_mode)
       VALUES ($1, $2, 'standard', $3, $4, $5)
       RETURNING agent_id, agent_name, can_spawn, inter_agent_mode`,
      [
        pairing.user_id,
        pairing.requested_agent_name,
        nextPosition,
        pairing.can_spawn === true,
        pairing.inter_agent_mode
      ]
    );
    const agent = agentResult.rows[0];

    const groupNames = parseJsonArray(pairing.group_names_json);
    if (pairing.inter_agent_mode === 'groups' && groupNames.length > 0) {
      await syncAgentGroups(client, pairing.user_id, agent.agent_id, groupNames);
    }

    const connectionResult = await client.query(
      `INSERT INTO external_bot_connections
         (user_id, agent_id, provider, provider_bot_ref, status, last_handshake_at)
       VALUES ($1, $2, $3, $4, 'connected', NOW()::timestamp)
       RETURNING connection_id, status`,
      [
        pairing.user_id,
        agent.agent_id,
        pairing.provider,
        providerBotRef || pairing.provider_bot_ref || null
      ]
    );

    const credential = await issueScopedCredential({
      agentId: agent.agent_id,
      scopes: getDefaultScopedScopes({ canSpawn: agent.can_spawn === true }),
      client
    });

    const consumed = await client.query(
      `UPDATE external_agent_pairing_codes
       SET redeemed_at = NOW()::timestamp,
           redeemed_agent_id = $2,
           connection_id = $3
       WHERE pairing_id = $1
         AND redeemed_at IS NULL
       RETURNING pairing_id`,
      [pairing.pairing_id, agent.agent_id, connectionResult.rows[0].connection_id]
    );

    // Conditional update is the concurrency gate. A losing transaction must
    // roll back its agent/credential creation instead of redeeming twice.
    if (consumed.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ error: { code: 'PAIRING_CODE_NOT_USABLE', message: 'Pairing code has already been used' } });
    }

    const userResult = await client.query(
      'SELECT encryption_salt FROM users WHERE user_id = $1',
      [pairing.user_id]
    );

    await client.query('COMMIT');
    client.release();

    res.status(201).json({
      connectionId: connectionResult.rows[0].connection_id,
      provider: pairing.provider,
      status: connectionResult.rows[0].status,
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
        agentToken: credential.token
      },
      encryptionSalt: userResult.rows[0]?.encryption_salt || null,
      encryptionParams: getEncryptionParams()
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackError) {
      // Ignore rollback errors.
    }
    client.release();
    handleDatabaseError(res, error, 'redeeming external agent pairing code');
  }
});

// Apply API key authentication to all subsequent agent routes
router.use(requireApiKey);

// Apply rate limiting to all agent API routes
router.use(agentApiRateLimiter);
router.use('/shared', require('../shared/routes').agents);
router.use(require('../shared/routes').fenceLegacy);

// Explicit acknowledgement for external consumers. Legacy polling still marks
// on delivery; markRead=false keeps a message pending until its reply is stored.
function acknowledgeInboxMessage(direct) {
  return async (req, res) => {
    try {
      const { messageId, responseType = 'text' } = req.body || {};
      if (!isValidUUID(messageId) || (!direct && !['text', 'response'].includes(responseType))) {
        return validationError(res, 'A UUID messageId and text or response responseType are required');
      }
      const agentName = req.headers['x-agent-name'];
      if (!agentName) return validationError(res, 'X-Agent-Name is required');
      const agent = await findAgentByName(req.user.userId, agentName);
      if (!agent) return validationError(res, 'Agent not found');
      const sql = direct
        ? 'UPDATE agent_messages SET read_at = COALESCE(read_at, NOW()::timestamp) WHERE agent_message_id = $1 AND recipient_agent_id = $2 RETURNING agent_message_id AS id'
        : responseType === 'text'
          ? 'UPDATE user_messages SET read_at = COALESCE(read_at, NOW()::timestamp) WHERE user_message_id = $1 AND agent_id = $2 RETURNING user_message_id AS id'
          : 'UPDATE user_responses SET read_at = COALESCE(read_at, NOW()::timestamp) WHERE response_id = $1 AND message_id IN (SELECT message_id FROM messages WHERE agent_id = $2) RETURNING response_id AS id';
      const result = await query(sql, [messageId, agent.agent_id]);
      if (!result.rows.length) {
        return res.status(404).json({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found in this agent inbox' } });
      }
      return res.json({ acknowledged: true, messageId });
    } catch (error) {
      return handleDatabaseError(res, error, 'acknowledging inbox message');
    }
  };
}

router.post('/responses/ack', acknowledgeInboxMessage(false));
router.post('/messages/direct/ack', acknowledgeInboxMessage(true));

/**
 * GET /api/agent/models
 * Return model catalog for this API key's user.
 * Optional query: provider=<name>
 */
router.get('/models', async (req, res) => {
  try {
    const userId = req.user.userId;
    const requestedProvider = typeof req.query.provider === 'string' ? req.query.provider.trim().toLowerCase() : '';

    if (requestedProvider) {
      return res.status(200).json({
        provider: requestedProvider,
        models: getProviderModels(requestedProvider, userId)
      });
    }

    return res.status(200).json({
      models: getProviderModelCatalog(userId)
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'fetching model catalog');
  }
});

/**
 * GET /api/agent/usage-limits
 * Lets an agent check how much of its own rate-limit budget it has used,
 * without spending any of that budget itself (the check is read-only and
 * does not count toward the limits it reports).
 */
router.get('/usage-limits', async (req, res) => {
  try {
    const clientIdentifier = resolveClientIdentifier(req);
    const agentName = resolveAgentName(req);

    const [polling, messageIngress, apiAggregate] = await Promise.all([
      getUsageStatus(agentPollingRateLimiter, { clientIdentifier, agentName }),
      getUsageStatus(agentMessageIngressRateLimiter, { clientIdentifier, agentName }),
      getUsageStatus(agentApiRateLimiter, { clientIdentifier })
    ]);

    return res.status(200).json({
      agentName,
      limits: [
        { ...polling, label: 'Polling requests' },
        { ...messageIngress, label: 'Messages sent' },
        { ...apiAggregate, label: 'Total API requests (all your agents)' }
      ]
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'fetching agent usage limits');
  }
});

/**
 * POST /api/agent/models/sync
 * Accept provider model list discovered online by CLI and store it for frontend.
 *
 * Request body:
 * - provider: string (required)
 * - models: string[] | {value,label}[] (required)
 * - source: string (optional)
 */
router.post('/models/sync', async (req, res) => {
  try {
    const userId = req.user.userId;
    const provider = typeof req.body.provider === 'string' ? req.body.provider.trim().toLowerCase() : '';
    const models = req.body.models;
    const source = typeof req.body.source === 'string' ? req.body.source.trim() : 'cli-online';

    if (!provider) {
      return validationError(res, 'provider is required');
    }
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      return validationError(res, `Unsupported provider: ${provider}`);
    }
    if (!Array.isArray(models) || models.length === 0) {
      return validationError(res, 'models must be a non-empty array');
    }

    const result = updateProviderModelsForUser(userId, provider, models, source);
    if (!result.updated) {
      return validationError(res, `Could not sync models: ${result.reason}`);
    }

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return handleDatabaseError(res, error, 'syncing model catalog');
  }
});

/**
 * POST /api/agent/messages
 * Send a message from an agent to the user
 *
 * Request body:
 * - content: string (required unless attachmentIds provided) - Message content
 * - priority: 0 | 1 | 2 (optional, default: 0) - 0=all ok, 1=needs attention, 2=urgent
 * - agentName: string (required) - Name of the agent
 * - attachmentIds: string[] (optional) - Array of attachment UUIDs to attach to the message
 *
 * Response: 201 Created
 * - messageId: string - UUID of created message
 * - newMessages: array - Any unread messages from user since last read
 */
router.post('/messages', agentMessageIngressRateLimiter, async (req, res) => {
  const client = await getClient();

  try {
    const { content, priority, agentName, encrypted, agentType, attachmentIds, runCommand, clientMessageId } = req.body;
    const userId = req.user.userId;
    const isEncrypted = encrypted === true;

    // Validate agent name
    const agentNameValidation = validateAgentName(agentName);
    if (!agentNameValidation.valid) {
      return validationError(res, agentNameValidation.message);
    }

    // Validate attachment IDs if provided
    const attachmentValidation = validateAttachmentIds(attachmentIds);
    if (!attachmentValidation.valid) {
      return validationError(res, attachmentValidation.message);
    }
    const validatedAttachmentIds = attachmentValidation.ids;
    const hasAttachments = validatedAttachmentIds.length > 0;

    // Validate message content (allow empty if attachments are present)
    const contentValidation = validateMessageContent(content, { allowEmpty: hasAttachments });
    if (!contentValidation.valid) {
      return validationError(res, contentValidation.message);
    }

    // Require either content or attachments
    const hasContent = content && typeof content === 'string' && content.trim().length > 0;
    if (!hasContent && !hasAttachments) {
      return validationError(res, 'Message must have either content or attachments');
    }

    // Reject rich_html messages that still contain template placeholders.
    // Agents occasionally send the documented example verbatim; without this
    // check the chat renders a useless "Interactive Content" card hiding the
    // raw `__REPLACE_WITH_TITLE__` tokens.
    if (hasContent && RICH_HTML_TEMPLATE_TOKEN.test(content) && RICH_HTML_MESSAGE_TYPE.test(content)) {
      return validationError(res, 'rich_html message contains unfilled REPLACE_WITH_* placeholders. Replace them with real title/html content before sending.');
    }
    if (hasContent && RICH_HTML_MESSAGE_TYPE.test(content) &&
        RICH_HTML_VERBATIM_STUBS.some(r => r.test(content))) {
      return validationError(res, 'rich_html message contains verbatim template stub content. Replace title/html with real task-specific content before sending.');
    }

    // Validate priority value (0=ok, 1=attention, 2=urgent)
    const priorityValidation = validatePriority(priority);
    if (!priorityValidation.valid) {
      return validationError(res, priorityValidation.message);
    }
    const messagePriority = priorityValidation.value;
    const isUrgent = priorityValidation.isUrgent;

    if (clientMessageId !== undefined && !isValidUUID(clientMessageId)) {
      return validationError(res, 'clientMessageId must be a UUID');
    }

    // Validate agent type if provided
    const validAgentTypes = ['standard', 'news_feed'];
    const resolvedAgentType = agentType && validAgentTypes.includes(agentType) ? agentType : 'standard';

    // Start transaction
    await client.query('BEGIN');

    // Create or find agent by name for the authenticated user
    let agentId;

    // Check if agent exists
    const agentResult = await client.query(
      'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_name = $2',
      [userId, agentName]
    );

    if (agentResult.rows.length > 0) {
      // Agent exists
      agentId = agentResult.rows[0].agent_id;
    } else {
      // Create new agent with specified type and next available position
      const newAgentResult = await client.query(
        `INSERT INTO agents (user_id, agent_name, agent_type, position, can_spawn)
         VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM agents WHERE user_id = $1), 1), TRUE)
         RETURNING agent_id, position`,
        [userId, agentName, resolvedAgentType]
      );
      agentId = newAgentResult.rows[0].agent_id;
    }

    if (process.env.FEATURE_IN_PLACE_AGENT_SHARING === 'true') {
      try {
        const owner = (await client.query('SELECT user_id FROM agents WHERE agent_id=$1 FOR UPDATE', [agentId])).rows[0];
        if (owner) {
          const privateLease = isEncrypted && clientMessageId && req.authContext?.type === 'agent_token' && req.authContext.agentId === agentId
            ? { runtimeId: req.headers['x-shared-runtime'], executionId: req.headers['x-shared-private-execution'] } : null;
          await chatThreadService.assertPrivateAgentReplyWritable(client, agentId, owner.user_id, privateLease);
        }
      } catch (error) {
        await client.query('ROLLBACK');
        if (error.status) return res.status(error.status).json({ error: { message: error.message } });
        throw error;
      }
    }

    // Check if agent is archived - prevent sending messages to archived agents
    const archived = await isAgentArchived(agentId);
    if (archived) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: {
          code: 'AGENT_ARCHIVED',
          message: 'Cannot send messages to an archived agent'
        }
      });
    }

    const supportsClientId = await hasMessagesClientIdColumn(client);
    if (supportsClientId && clientMessageId) {
      const existing = await client.query(
        'SELECT message_id, content, encrypted FROM messages WHERE agent_id = $1 AND client_message_id = $2',
        [agentId, clientMessageId]
      );
      if (existing.rows.length > 0) {
        const linked = await client.query('SELECT attachment_id FROM message_attachments WHERE message_id = $1 ORDER BY attachment_order ASC', [existing.rows[0].message_id]);
        if ((existing.rows[0].content || '') !== (content || '') || Boolean(existing.rows[0].encrypted) !== Boolean(encrypted) ||
            JSON.stringify(linked.rows.map(row => row.attachment_id)) !== JSON.stringify(validatedAttachmentIds)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'clientMessageId already belongs to different message content or attachments' } });
        }
        await client.query('COMMIT');
        return res.status(200).json({ status: 'sent', messageId: existing.rows[0].message_id, attachmentCount: linked.rows.length, newMessages: [], idempotent: true });
      }
    }

    // Verify attachments exist, belong to this agent, and are not already attached to another message
    if (hasAttachments) {
      const attachmentCheck = await client.query(
        `SELECT attachment_id FROM attachments
         WHERE attachment_id IN (${validatedAttachmentIds.map((_, index) => `$${index + 2}`).join(', ')})
         AND agent_id = $1`,
        [agentId, ...validatedAttachmentIds]
      );

      if (attachmentCheck.rows.length !== validatedAttachmentIds.length) {
        await client.query('ROLLBACK');
        return validationError(res, 'One or more attachment IDs are invalid or do not belong to this agent');
      }

      // Check if any attachments are already linked to a message
      const alreadyLinked = await client.query(
        `SELECT attachment_id FROM message_attachments
         WHERE attachment_id IN (${validatedAttachmentIds.map((_, index) => `$${index + 1}`).join(', ')})`,
        validatedAttachmentIds
      );

      if (alreadyLinked.rows.length > 0) {
        await client.query('ROLLBACK');
        return validationError(res, 'One or more attachments are already attached to another message');
      }
    }

    // Update last_seen_at for this agent (tracks when agent was last active)
    await client.query('UPDATE agents SET last_seen_at = NOW()::timestamp WHERE agent_id = $1', [agentId]);

    // Insert message into database with encryption flag
    // Content can be null if only attachments are provided
    const finalContent = hasContent ? content : null;
    const finalRunCommand = (typeof runCommand === 'string' && runCommand.trim()) ? runCommand.trim().slice(0, 500) : null;
    const supportsRunCommand = await hasMessagesRunCommandColumn(client);
    const messageResult = supportsRunCommand && supportsClientId
      ? await client.query(
        `INSERT INTO messages (agent_id, message_type, content, priority, urgent, encrypted, run_command, client_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (agent_id, client_message_id) WHERE client_message_id IS NOT NULL
         DO UPDATE SET client_message_id = EXCLUDED.client_message_id
         RETURNING message_id`,
        [agentId, 'message', finalContent, messagePriority, isUrgent, isEncrypted, finalRunCommand, clientMessageId || null]
      )
      : supportsRunCommand
      ? await client.query(
        `INSERT INTO messages (agent_id, message_type, content, priority, urgent, encrypted, run_command)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING message_id`,
        [agentId, 'message', finalContent, messagePriority, isUrgent, isEncrypted, finalRunCommand]
      )
      : supportsClientId
      ? await client.query(
        `INSERT INTO messages (agent_id, message_type, content, priority, urgent, encrypted, client_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (agent_id, client_message_id) WHERE client_message_id IS NOT NULL
         DO UPDATE SET client_message_id = EXCLUDED.client_message_id RETURNING message_id`,
        [agentId, 'message', finalContent, messagePriority, isUrgent, isEncrypted, clientMessageId || null]
      )
      : await client.query(
        `INSERT INTO messages (agent_id, message_type, content, priority, urgent, encrypted)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING message_id`,
        [agentId, 'message', finalContent, messagePriority, isUrgent, isEncrypted]
      );

    const messageId = messageResult.rows[0].message_id;

    // Link attachments to the message
    if (hasAttachments) {
      for (let i = 0; i < validatedAttachmentIds.length; i++) {
        await client.query(
          `INSERT INTO message_attachments (message_id, attachment_id, attachment_order)
           VALUES ($1, $2, $3)`,
          [messageId, validatedAttachmentIds[i], i]
        );
      }
    }

    // Commit the transaction
    await client.query('COMMIT');

    // Return success response with messageId
    // NOTE: Previously this endpoint fetched and marked-as-read ALL unread user
    // messages as a side effect. This caused a bug where messages sent by the user
    // while the agent was working would be silently marked as read when the agent
    // posted its response — the agent never saw them. Unread messages should only
    // be consumed by the dedicated GET /agent/responses polling endpoint.
    res.status(201).json({
      status: 'sent',
      messageId: messageId,
      attachmentCount: validatedAttachmentIds.length,
      newMessages: []
    });

  } catch (error) {
    // Rollback transaction on error
    await client.query('ROLLBACK');
    return handleDatabaseError(res, error, 'message creation');
  } finally {
    // Release client back to pool
    client.release();
  }
});

/**
 * POST /api/agent/questions
 * Send an interactive question with multiple choice options or free text
 *
 * Request body:
 * - content: string (required unless attachmentIds provided) - Question content
 * - priority: 0 | 1 | 2 (optional, default: 0) - 0=all ok, 1=needs attention, 2=urgent
 * - agentName: string (required) - Name of the agent
 * - options: array (optional) - Array of option objects
 *   - text: string (required) - Option text
 *   - benefits: string (optional) - Benefits of this option
 *   - downsides: string (optional) - Downsides of this option
 *   - isDefault: boolean (optional) - Whether this is the default/suggested option
 * - attachmentIds: string[] (optional) - Array of attachment UUIDs to attach to the question
 *
 * Response: 201 Created
 * - questionId: string - UUID of created question message
 * - attachmentCount: number - Number of attachments attached
 */
router.post('/questions', agentMessageIngressRateLimiter, async (req, res) => {
  const client = await getClient();

  try {
    const { content, priority, agentName, options, allowFreeResponse, freeResponseHint, encrypted, attachmentIds } = req.body;
    const userId = req.user.userId;
    const isEncrypted = encrypted === true;

    // Validate agent name
    const agentNameValidation = validateAgentName(agentName);
    if (!agentNameValidation.valid) {
      return validationError(res, agentNameValidation.message);
    }

    // Validate attachment IDs if provided
    const attachmentValidation = validateAttachmentIds(attachmentIds);
    if (!attachmentValidation.valid) {
      return validationError(res, attachmentValidation.message);
    }
    const validatedAttachmentIds = attachmentValidation.ids;
    const hasAttachments = validatedAttachmentIds.length > 0;

    // Validate question content (allow empty if attachments are present)
    const contentValidation = validateMessageContent(content, { allowEmpty: hasAttachments });
    if (!contentValidation.valid) {
      return validationError(res, contentValidation.message);
    }

    // Require either content or attachments
    const hasContent = content && typeof content === 'string' && content.trim().length > 0;
    if (!hasContent && !hasAttachments) {
      return validationError(res, 'Question must have either content or attachments');
    }

    const allowOpenResponse = validateBoolean(allowFreeResponse, false);
    const hintValidation = validateFreeResponseHint(freeResponseHint);
    if (!hintValidation.valid) {
      return validationError(res, hintValidation.message);
    }

    const hasOptions = Array.isArray(options) && options.length > 0;
    if (hasOptions) {
      const optionsValidation = validateOptionsArray(options);
      if (!optionsValidation.valid) {
        return validationError(res, optionsValidation.message);
      }
    }
    // If no options provided, automatically enable free response
    const autoFreeResponse = !hasOptions || allowOpenResponse;

    // Validate priority value (0=ok, 1=attention, 2=urgent)
    const priorityValidation = validatePriority(priority);
    if (!priorityValidation.valid) {
      return validationError(res, priorityValidation.message);
    }
    const messagePriority = priorityValidation.value;
    const isUrgent = priorityValidation.isUrgent;

    // Start transaction
    await client.query('BEGIN');

    // Create or find agent by name for the authenticated user
    let agentId;

    // Check if agent exists
    const agentResult = await client.query(
      'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_name = $2',
      [userId, agentName]
    );

    if (agentResult.rows.length > 0) {
      // Agent exists
      agentId = agentResult.rows[0].agent_id;
    } else {
      // Create new agent with default type and next available position
      const newAgentResult = await client.query(
        `INSERT INTO agents (user_id, agent_name, agent_type, position, can_spawn)
         VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM agents WHERE user_id = $1), 1), TRUE)
         RETURNING agent_id, position`,
        [userId, agentName, 'standard']
      );
      agentId = newAgentResult.rows[0].agent_id;
    }

    if (process.env.FEATURE_IN_PLACE_AGENT_SHARING === 'true') {
      try {
        const owner = (await client.query('SELECT user_id FROM agents WHERE agent_id=$1 FOR UPDATE', [agentId])).rows[0];
        if (owner) await chatThreadService.assertPrivateThreadWritable(client, agentId, owner.user_id);
      } catch (error) {
        await client.query('ROLLBACK');
        if (error.status) return res.status(error.status).json({ error: { message: error.message } });
        throw error;
      }
    }

    // Check if agent is archived - prevent sending questions to archived agents
    const archived = await isAgentArchived(agentId);
    if (archived) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: {
          code: 'AGENT_ARCHIVED',
          message: 'Cannot send questions to an archived agent'
        }
      });
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
        return validationError(res, 'One or more attachment IDs are invalid or do not belong to this agent');
      }

      // Check if any attachments are already linked to a message
      const alreadyLinked = await client.query(
        `SELECT attachment_id FROM message_attachments
         WHERE attachment_id = ANY($1)`,
        [validatedAttachmentIds]
      );

      if (alreadyLinked.rows.length > 0) {
        await client.query('ROLLBACK');
        return validationError(res, 'One or more attachments are already attached to another message');
      }
    }

    // Insert message with type 'question' and encryption flag
    // Content can be null if only attachments are provided
    const finalContent = hasContent ? content : null;
    const messageResult = await client.query(
      `INSERT INTO messages (agent_id, message_type, content, priority, urgent, allow_free_response, free_response_hint, encrypted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING message_id`,
      [agentId, 'question', finalContent, messagePriority, isUrgent, autoFreeResponse, hintValidation.value, isEncrypted]
    );

    const questionId = messageResult.rows[0].message_id;

    // Link attachments to the message
    if (hasAttachments) {
      for (let i = 0; i < validatedAttachmentIds.length; i++) {
        await client.query(
          `INSERT INTO message_attachments (message_id, attachment_id, attachment_order)
           VALUES ($1, $2, $3)`,
          [questionId, validatedAttachmentIds[i], i]
        );
      }
    }

    // Insert all options with order, benefits, downsides, isDefault
    if (hasOptions) {
      for (let i = 0; i < options.length; i++) {
        const option = options[i];

        await client.query(
          `INSERT INTO question_options (message_id, option_text, benefits, downsides, is_default, option_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            questionId,
            option.text,
            option.benefits || null,
            option.downsides || null,
            option.isDefault === true,
            i
          ]
        );
      }
    }

    // Update last_seen_at for this agent (tracks when agent was last active)
    await client.query('UPDATE agents SET last_seen_at = NOW()::timestamp WHERE agent_id = $1', [agentId]);

    // Commit transaction
    await client.query('COMMIT');

    // Return success response with questionId and attachment count
    res.status(201).json({
      questionId: questionId,
      attachmentCount: validatedAttachmentIds.length
    });

  } catch (error) {
    // Rollback transaction on error
    await client.query('ROLLBACK');
    return handleDatabaseError(res, error, 'question creation');
  } finally {
    // Release client back to pool
    client.release();
  }
});

/**
 * GET /api/agent/responses
 * Poll for user replies (option + free-text) that agents can fetch
 *
 * Query parameters:
 * - since: ISO 8601 timestamp (optional) - Only return responses after this time
 * - agentName: string (optional) - Filter responses by agent name
 * - agentCliVersion: string (optional) - Agent-reported CLI version (for update checks; not user-visible)
 *
 * Response: 200 OK
 * - responses: array of response objects
 *   - responseType: 'option' | 'text'
 *   - agentId: string - UUID of the agent that received the response
 *   - agentName: string - Name of the agent
 *   - questionId: string (option responses only) - UUID of the question
 *   - selectedOption: string (option responses only) - Selected option text
 *   - messageId: string (text responses only) - UUID of the user message
 *   - content: string (text responses only) - Free-text reply
 *   - timestamp: string - ISO 8601 timestamp of when the response was recorded
 *   - attachments: array (text responses only) - Array of attachment metadata objects
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
 */
router.get('/responses', agentPollingRateLimiter, async (req, res) => {
  try {
    if (req.query.markRead !== undefined && !['true', 'false'].includes(req.query.markRead)) {
      return validationError(res, 'markRead must be true or false');
    }
    const markRead = req.query.markRead !== 'false';
    const userId = req.user.userId;
    const { since, agentName, agentCliVersion } = req.query;
    const normalizedAgentCliVersion = normalizeCliVersion(agentCliVersion);
    const parsedAgentCliVersion = parseCliVersion(normalizedAgentCliVersion);

    let sinceValue = null;

    // Build dynamic query parameters
    let paramIndex = 1;
    const queryParams = [userId];
    const textQueryParams = [userId];

    // Validate agentName if provided
    let agentId = null;
    if (agentName) {
      const agentNameValidation = validateAgentName(agentName);
      if (!agentNameValidation.valid) {
        return validationError(res, agentNameValidation.message);
      }
      // Look up the agent
      const agent = await findAgentByName(userId, agentName);
      if (!agent) {
        // No agent found - return empty responses (not an error, just no data)
        return res.status(200).json({ responses: [], poll: getPollAdvice(req, false) });
      }
      agentId = agent.agent_id;

      // Update last_seen_at for this agent (tracks when agent was last active)
      // and persist reported CLI version when provided in valid semver form.
      if (parsedAgentCliVersion) {
        await query(
          `UPDATE agents
           SET last_seen_at = NOW()::timestamp,
               reported_cli_version = $1,
               reported_cli_version_at = NOW()::timestamp
           WHERE agent_id = $2`,
          [normalizedAgentCliVersion, agentId]
        );
      } else {
        await query('UPDATE agents SET last_seen_at = NOW()::timestamp WHERE agent_id = $1', [agentId]);
      }
    }

    if (since) {
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

    // Build WHERE clause conditions dynamically
    // Only return UNREAD messages (read_at IS NULL) for both types
    let optionWhereConditions = ['a.user_id = $1', 'ur.read_at IS NULL'];
    // Note: pg-mem has edge cases when combining `um.read_at IS NULL` with other predicates
    // in joined queries; use an equivalent IN-subquery for reliable behavior in tests.
    // Also exclude archived messages using a NOT IN subquery.
    let textWhereConditions = [
      'a.user_id = $1',
      'um.user_message_id IN (SELECT user_message_id FROM user_messages WHERE read_at IS NULL)',
      'um.user_message_id NOT IN (SELECT user_message_id FROM archived_messages WHERE user_message_id IS NOT NULL)',
      '(um.hidden_from_agent = FALSE OR um.hidden_from_agent IS NULL)'
    ];
    paramIndex = 2;

    if (agentId) {
      optionWhereConditions.push(`a.agent_id = $${paramIndex}`);
      textWhereConditions.push(`a.agent_id = $${paramIndex}`);
      queryParams.push(agentId);
      textQueryParams.push(agentId);
      paramIndex++;
    }

    if (sinceValue) {
      optionWhereConditions.push(`ur.created_at > $${paramIndex}`);
      textWhereConditions.push(`um.created_at > $${paramIndex}`);
      queryParams.push(sinceValue);
      textQueryParams.push(sinceValue);
      paramIndex++;
    }

    const queryText = `
      SELECT 
        ur.response_id,
        ur.message_id as question_id,
        qo.option_text as selected_option,
        ur.free_response,
        ur.created_at as timestamp,
        a.agent_id,
        a.agent_name
      FROM user_responses ur
      JOIN messages m ON ur.message_id = m.message_id
      JOIN agents a ON m.agent_id = a.agent_id
      LEFT JOIN question_options qo ON ur.option_id = qo.option_id
      WHERE ${optionWhereConditions.join(' AND ')}
      ORDER BY ur.created_at ASC
    `;

    const textQuery = `
      SELECT
        um.user_message_id,
        um.content,
        um.encrypted,
        um.created_at,
        um.run_overrides,
        a.agent_id,
        a.agent_name
      FROM user_messages um
      JOIN agents a ON um.agent_id = a.agent_id
      WHERE ${textWhereConditions.join(' AND ')}
      ORDER BY um.created_at ASC
    `;

    const optionResult = await query(queryText, queryParams);
    const textResult = await query(textQuery, textQueryParams);

    // Messages queued with different run settings (provider/model/effort/permissions)
    // must run as separate turns: hand the runner only the leading batch that shares
    // the oldest message's settings and leave the rest unread for the next poll.
    let batchRunOverrides = null;
    if (agentId && textResult.rows.length > 0) {
      const overridesKey = (row) => JSON.stringify(row.run_overrides || null);
      const firstKey = overridesKey(textResult.rows[0]);
      const cut = textResult.rows.findIndex((row) => overridesKey(row) !== firstKey);
      if (cut > 0) textResult.rows = textResult.rows.slice(0, cut);
      batchRunOverrides = textResult.rows[0].run_overrides || null;
    }

    // Mark option responses (user_responses) as read by agent
    if (markRead && optionResult.rows.length > 0) {
      const responseIds = optionResult.rows.map(row => row.response_id);
      const updated = await query(
        `UPDATE user_responses SET read_at = NOW()::timestamp WHERE response_id = ANY($1) AND read_at IS NULL`,
        [responseIds]
      );

      if (SHOULD_USE_TEST_DB_BULK_FALLBACK && ((updated && updated.rowCount) || 0) !== responseIds.length) {
        for (const responseId of responseIds) {
          await query(
            'UPDATE user_responses SET read_at = NOW()::timestamp WHERE response_id = $1 AND read_at IS NULL',
            [responseId]
          );
        }
      }
    }

    // Mark text responses as read by agent
    if (markRead && textResult.rows.length > 0) {
      const userMessageIds = textResult.rows.map(row => row.user_message_id);
      const updated = await query(
        `UPDATE user_messages SET read_at = NOW()::timestamp WHERE user_message_id = ANY($1) AND read_at IS NULL`,
        [userMessageIds]
      );

      if (SHOULD_USE_TEST_DB_BULK_FALLBACK && ((updated && updated.rowCount) || 0) !== userMessageIds.length) {
        for (const messageId of userMessageIds) {
          await query(
            'UPDATE user_messages SET read_at = NOW()::timestamp WHERE user_message_id = $1 AND read_at IS NULL',
            [messageId]
          );
        }
      }
    }

    // Fetch attachments for text responses (user messages) - avoid N+1 queries
    const userMessageIdsForAttachments = textResult.rows.map(row => row.user_message_id);
    const userAttachmentsMap = {};
    if (userMessageIdsForAttachments.length > 0) {
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
        WHERE uma.user_message_id IN (${userMessageIdsForAttachments.map((_, index) => `$${index + 1}`).join(', ')})
        ORDER BY uma.user_message_id, uma.attachment_order ASC
      `, userMessageIdsForAttachments);

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
          downloadUrl: `/api/agent/attachments/${att.attachment_id}`
        });
      }
    }

    const optionResponses = optionResult.rows.map(row => ({
      responseId: row.response_id,
      responseType: row.free_response && !row.selected_option ? 'open' : (row.free_response && row.selected_option ? 'option+open' : 'option'),
      from: 'user',  // Currently all responses come from the user; future: could be another agent's name
      agentId: row.agent_id,
      agentName: row.agent_name,
      questionId: row.question_id,
      selectedOption: row.selected_option,
      freeResponse: row.free_response,
      timestamp: row.timestamp.toISOString()
    }));

    const updatePrefix = '__AGENT_UPDATE__:';
    const textResponses = textResult.rows.map((row) => {
      const isQueuedUpdate =
        typeof row.content === 'string' && row.content.startsWith(updatePrefix);

      if (isQueuedUpdate) {
        const encryptedPayload = row.content.slice(updatePrefix.length);
        return {
          responseType: 'text',
          from: 'system',
          agentId: row.agent_id,
          agentName: row.agent_name,
          messageId: row.user_message_id,
          content: 'System update is available. Ask the user to confirm update. If they confirm, the agent can self-update automatically.',
          encrypted: false,
          timestamp: row.created_at.toISOString(),
          attachments: userAttachmentsMap[row.user_message_id] || [],
          updateAction: {
            type: 'queued_self_update',
            encryptedPayload
          }
        };
      }

      return {
        responseType: 'text',
        from: 'user',  // Currently all responses come from the user; future: could be another agent's name
        agentId: row.agent_id,
        agentName: row.agent_name,
        messageId: row.user_message_id,
        content: row.content,
        encrypted: row.encrypted || false,
        timestamp: row.created_at.toISOString(),
        attachments: userAttachmentsMap[row.user_message_id] || []
      };
    });

    const combinedResponses = [...optionResponses, ...textResponses].sort((a, b) => {
      return new Date(a.timestamp) - new Date(b.timestamp);
    });

    // Return ALL responses for this agent (not just the latest)
    // The agent needs to see all new messages since their last check
    res.status(200).json({
      responses: combinedResponses,
      runOverrides: batchRunOverrides,
      poll: getPollAdvice(req, combinedResponses.length > 0)
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching responses');
  }
});

/**
 * POST /api/agent/heartbeat
 * Runner heartbeat for "still working" status + stop check.
 *
 * Request body:
 * - agentName: string (required) - Name of agent sending heartbeat
 * - isWorking: boolean (optional, default true) - Whether a command is currently running
 *
 * Response: 200 OK
 * - status: 'ok'
 * - agentId: string
 * - agentName: string
 * - isWorking: boolean
 * - heartbeatAt: string (ISO timestamp)
 * - stopRequested: boolean
 * - stopRequestedAt: string|null
 */
router.post('/heartbeat', agentPollingRateLimiter, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName, isWorking = true } = req.body || {};

    const agentNameValidation = validateAgentName(agentName);
    if (!agentNameValidation.valid) {
      return validationError(res, agentNameValidation.message);
    }

    const working = validateBoolean(isWorking, true);
    const agent = await findAgentByName(userId, agentName);
    if (!agent) {
      return res.status(404).json({
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'Agent not found for the authenticated user'
        }
      });
    }

    const heartbeatAt = new Date();
    const heartbeatTimestamp = formatTimestampForDatabase(heartbeatAt);
    if (!heartbeatTimestamp) {
      return internalError(res, 'Failed to format heartbeat timestamp');
    }

    await query(
      `UPDATE agents
       SET
         last_seen_at = $2,
         is_working = $3,
         last_working_heartbeat_at = CASE
           WHEN $3 = TRUE THEN $2
           ELSE last_working_heartbeat_at
         END
       WHERE agent_id = $1`,
      [agent.agent_id, heartbeatTimestamp, working === true]
    );

    let stopRequested = false;
    let stopRequestedAt = null;

    // Check DB-level stop flag (works for remote agents without local dirs)
    if (agent.stop_requested_at) {
      stopRequested = true;
      stopRequestedAt = new Date(agent.stop_requested_at).toISOString();
    }

    // Also check filesystem stop flag (backwards-compatible).
    // Uses async fs.promises so the heartbeat hot path doesn't block the
    // event loop on disk I/O.
    if (!stopRequested) {
      try {
        const agentFolder = sanitizeFolderName(agentName);
        const agentDir = findAgentChatspaceDir(agentFolder);
        if (agentDir) {
          const stopFlagPath = path.join(agentDir, 'agent_state', '.stop_requested');
          try {
            const raw = (await fs.promises.readFile(stopFlagPath, 'utf8')).trim();
            stopRequested = true;
            if (raw) {
              const ts = validateTimestamp(raw);
              stopRequestedAt = ts.valid ? ts.date.toISOString() : null;
            }
          } catch (readErr) {
            if (readErr.code !== 'ENOENT') {
              // Real I/O error (permission, etc.) — best-effort, leave stopRequested false
            }
          }
        }
      } catch (_err) {
        // Stop-check path lookup is best-effort; heartbeat still succeeds.
      }
    }

    return res.status(200).json({
      status: 'ok',
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      isWorking: working === true,
      heartbeatAt: heartbeatAt.toISOString(),
      stopRequested,
      stopRequestedAt,
      poll: getPollAdvice(req, stopRequested)
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'processing heartbeat');
  }
});

/**
 * Helper to look up an agent by name for the authenticated user
 */
async function findAgentByName(userId, agentName) {
  const normalizedAgentName = agentName.trim();
  const agentResult = await query(
    'SELECT agent_id, agent_name, agent_type, stop_requested_at FROM agents WHERE user_id = $1 AND agent_name = $2',
    [userId, normalizedAgentName]
  );

  if (agentResult.rows.length === 0) {
    return null;
  }

  return agentResult.rows[0];
}

/**
 * GET /api/agent/messages/history
 * Return all messages for a specific agent (includes agent messages, user responses, and user messages)
 */
router.get('/messages/history', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName } = req.query;

    if (!agentName) {
      return validationError(res, 'agentName query parameter is required');
    }

    const agentNameValidation = validateAgentName(agentName);
    if (!agentNameValidation.valid) {
      return validationError(res, agentNameValidation.message);
    }

    const agent = await findAgentByName(userId, agentName);
    if (!agent) {
      return res.status(404).json({
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'Agent not found for the authenticated user'
        }
      });
    }

    // Fetch agent messages (messages and questions), excluding archived
    const messagesResult = await query(
      `SELECT 
        m.message_id,
        m.message_type,
        m.content,
        m.encrypted,
        m.priority,
        m.urgent,
        m.allow_free_response,
        m.free_response_hint,
        m.created_at
      FROM messages m
      LEFT JOIN archived_messages am ON m.message_id = am.message_id
      WHERE m.agent_id = $1 AND am.archived_message_id IS NULL AND (m.hidden_from_agent = FALSE OR m.hidden_from_agent IS NULL)
      ORDER BY m.created_at ASC`,
      [agent.agent_id]
    );

    // Fetch user responses (option selections and free responses to questions)
    const userResponsesResult = await query(
      `SELECT 
        ur.response_id,
        ur.message_id as question_id,
        qo.option_text as selected_option,
        ur.free_response,
        ur.created_at
      FROM user_responses ur
      JOIN messages m ON ur.message_id = m.message_id
      LEFT JOIN question_options qo ON ur.option_id = qo.option_id
      WHERE m.agent_id = $1
      ORDER BY ur.created_at ASC`,
      [agent.agent_id]
    );

    // Fetch user messages (free-text messages from the user), excluding archived and hidden
    const userMessagesResult = await query(
      `SELECT
        um.user_message_id,
        um.content,
        um.encrypted,
        um.created_at
      FROM user_messages um
      LEFT JOIN archived_messages am ON um.user_message_id = am.user_message_id
      WHERE um.agent_id = $1 AND am.archived_message_id IS NULL AND (um.hidden_from_agent = FALSE OR um.hidden_from_agent IS NULL)
      ORDER BY um.created_at ASC`,
      [agent.agent_id]
    );

    // Fetch inter-agent messages (DMs sent and received by this agent)
    const interAgentMessagesResult = await query(
      `SELECT
        am.agent_message_id,
        am.content,
        am.encrypted,
        am.priority,
        am.created_at,
        am.sender_agent_id,
        am.recipient_agent_id,
        sender.agent_name as sender_name,
        recipient.agent_name as recipient_name
      FROM agent_messages am
      JOIN agents sender ON am.sender_agent_id = sender.agent_id
      JOIN agents recipient ON am.recipient_agent_id = recipient.agent_id
      WHERE (am.sender_agent_id = $1 OR am.recipient_agent_id = $1)
      ORDER BY am.created_at ASC`,
      [agent.agent_id]
    );

    // Preserve attachment metadata in history so reconnecting agents can retrieve
    // images and files through the authenticated agent download endpoint.
    const attachmentMap = new Map();
    for (const [table, idColumn, ids] of [
      ['message_attachments', 'message_id', messagesResult.rows.map(row => row.message_id)],
      ['user_message_attachments', 'user_message_id', userMessagesResult.rows.map(row => row.user_message_id)]
    ]) {
      if (!ids.length) continue;
      const result = await query(`
        SELECT link.${idColumn} AS parent_id, a.*
        FROM ${table} link JOIN attachments a ON a.attachment_id = link.attachment_id
        WHERE link.${idColumn} IN (${ids.map((_, index) => `$${index + 1}`).join(', ')})
        ORDER BY link.attachment_order ASC`, ids);
      for (const att of result.rows) {
        const entries = attachmentMap.get(att.parent_id) || [];
        entries.push({
          attachmentId: att.attachment_id, contentType: att.content_type,
          fileName: att.file_name, sizeBytes: Number(att.size_bytes),
          width: att.width, height: att.height, encrypted: att.encrypted,
          encryption: att.encrypted ? { alg: 'AES-GCM', ivBase64: att.iv_base64, tagBase64: att.auth_tag_base64 } : null,
          downloadUrl: `/api/agent/attachments/${att.attachment_id}`
        });
        attachmentMap.set(att.parent_id, entries);
      }
    }

    // Build combined message list
    const allMessages = [];

    // Add agent messages
    for (const row of messagesResult.rows) {
      allMessages.push({
        messageId: row.message_id,
        type: row.message_type === 'question' ? 'agent_question' : 'agent_message',
        from: agentName,
        content: row.content,
        encrypted: row.encrypted,
        attachments: attachmentMap.get(row.message_id) || [],
        priority: row.priority,
        urgent: row.urgent,
        allowFreeResponse: row.allow_free_response,
        freeResponseHint: row.free_response_hint,
        timestamp: row.created_at.toISOString()
      });
    }

    // Add user responses (answers to questions)
    for (const row of userResponsesResult.rows) {
      allMessages.push({
        messageId: row.response_id,
        type: 'user_response',
        from: 'user',
        questionId: row.question_id,
        selectedOption: row.selected_option,
        freeResponse: row.free_response,
        timestamp: row.created_at.toISOString()
      });
    }

    // Add user messages (free-text messages).
    // Queued self-update payloads are stored as `__AGENT_UPDATE__:<encrypted blob>`
    // user_messages so they flow through the same polling path. The blob is huge
    // base64 and is NOT decryptable by the agent's normal `_decrypt_message`
    // helper (its `iv:tag:ct` shape gets a 4th `__AGENT_UPDATE__` segment when
    // split on `:`), so leaving the raw content in history both consumes the
    // context window and drops a "[Decryption failed]"-style blob into the
    // prompt. Replace it here with a short readable system note, matching the
    // user-facing translation in userApiRoutes /messages.
    const queuedUpdatePrefix = '__AGENT_UPDATE__:';
    for (const row of userMessagesResult.rows) {
      const isQueuedSelfUpdate =
        typeof row.content === 'string' && row.content.startsWith(queuedUpdatePrefix);
      allMessages.push({
        messageId: row.user_message_id,
        type: 'user_message',
        from: isQueuedSelfUpdate ? 'system' : 'user',
        content: isQueuedSelfUpdate
          ? '[system] Self-update package was queued by the user.'
          : row.content,
        encrypted: isQueuedSelfUpdate ? false : row.encrypted,
        attachments: attachmentMap.get(row.user_message_id) || [],
        messageSubtype: isQueuedSelfUpdate ? 'queued_self_update' : undefined,
        timestamp: row.created_at.toISOString()
      });
    }

    // Add inter-agent messages (DMs sent and received)
    for (const row of interAgentMessagesResult.rows) {
      const isSender = row.sender_agent_id === agent.agent_id;
      const otherAgentName = isSender ? row.recipient_name : row.sender_name;

      allMessages.push({
        messageId: row.agent_message_id,
        type: isSender ? 'agent_dm_sent' : 'agent_dm_received',
        from: isSender ? agentName : `agent:${row.sender_name}`,
        to: isSender ? `agent:${row.recipient_name}` : agentName,
        otherAgent: otherAgentName,
        content: row.content,
        encrypted: row.encrypted || false,
        priority: row.priority,
        timestamp: row.created_at.toISOString()
      });
    }

    // Sort by timestamp
    allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    res.status(200).json({
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      messageCount: allMessages.length,
      messages: allMessages
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching agent message history');
  }
});

/**
 * GET /api/agent/messages/latest
 * Return the most recent message for a specific agent
 */
router.get('/messages/latest', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName } = req.query;

    if (!agentName) {
      return validationError(res, 'agentName query parameter is required');
    }

    const agentNameValidation = validateAgentName(agentName);
    if (!agentNameValidation.valid) {
      return validationError(res, agentNameValidation.message);
    }

    const agent = await findAgentByName(userId, agentName);
    if (!agent) {
      return res.status(404).json({
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'Agent not found for the authenticated user'
        }
      });
    }

    const latestResult = await query(
      `SELECT 
        m.message_id,
        m.message_type,
        m.content,
        m.priority,
        m.urgent,
        m.allow_free_response,
        m.free_response_hint,
        m.created_at
      FROM messages m
      LEFT JOIN archived_messages am ON m.message_id = am.message_id
      WHERE m.agent_id = $1 AND am.archived_message_id IS NULL
      ORDER BY m.created_at DESC
      LIMIT 1`,
      [agent.agent_id]
    );

    const latestRow = latestResult.rows[0];

    res.status(200).json({
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      latestMessage: latestRow ? {
        messageId: latestRow.message_id,
        type: latestRow.message_type === 'question' ? 'agent_question' : 'agent_message',
        content: latestRow.content,
        priority: latestRow.priority,
        urgent: latestRow.urgent,
        allowFreeResponse: latestRow.allow_free_response,
        freeResponseHint: latestRow.free_response_hint,
        timestamp: latestRow.created_at.toISOString()
      } : null
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching latest agent message');
  }
});

/**
 * Find agent chatspace directory by searching multiple locations
 * Searches in cwd/.chatspace, cwd/chatspace, and tmp subdirectories
 * @param {string} agentFolder - The sanitized agent folder name
 * @returns {string|null} Path to agent directory or null if not found
 */
function findAgentChatspaceDir(agentFolder) {
  const fs = require('fs');
  const path = require('path');

  const searchPaths = [
    path.join(process.cwd(), '.chatspace', agentFolder),
    path.join(process.env.HOME || '', '.chatspace', agentFolder),
    path.join(process.cwd(), 'chatspace', agentFolder),
    path.join(process.env.HOME || '', 'chatspace', agentFolder),
  ];

  // Also check tmp subdirectories (for development/testing)
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (fs.existsSync(tmpDir)) {
    try {
      const tmpSubdirs = fs.readdirSync(tmpDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .flatMap(d => [
          path.join(tmpDir, d.name, '.chatspace', agentFolder),
          path.join(tmpDir, d.name, 'chatspace', agentFolder)
        ]);
      searchPaths.push(...tmpSubdirs);
    } catch (e) {
      // Ignore errors reading tmp dir
    }
  }

  // Return first existing path
  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * GET /api/agent/config
 * Get current agent configuration and allowed permissions
 *
 * Query parameters:
 * - agentName: string (required) - Name of the agent
 *
 * Response: 200 OK
 * - config: current agent config (model_provider, model, approval_mode, sandbox_mode)
 * - allowedPermissions: what options the CLI user allowed
 */
router.get('/config', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName } = req.query;

    if (!agentName) {
      return validationError(res, 'agentName query parameter is required');
    }

    const agentNameValidation = validateAgentName(agentName);
    if (!agentNameValidation.valid) {
      return validationError(res, agentNameValidation.message);
    }

    const agent = await findAgentByName(userId, agentName);
    if (!agent) {
      return res.status(404).json({
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'Agent not found for the authenticated user'
        }
      });
    }

    const runtimeState = await loadAgentRuntimeState({
      userId,
      agentId: agent.agent_id,
      agentName,
      defaults: DEFAULT_AGENT_API_CONFIG
    });
    const config = runtimeState.config;
    const allowedPermissions = runtimeState.allowedPermissions;

    // Get inter_agent_mode and spawning info from database
    const modeResult = await query(
      'SELECT inter_agent_mode, can_spawn, spawn_depth, parent_agent_id, auto_spawned FROM agents WHERE agent_id = $1',
      [agent.agent_id]
    );
    const agentMeta = modeResult.rows.length > 0 ? modeResult.rows[0] : {};
    const interAgentMode = agentMeta.inter_agent_mode || 'disabled';

    res.status(200).json({
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      config,
      allowedPermissions,
      interAgentMode,
      canSpawn: agentMeta.can_spawn || false,
      spawnDepth: agentMeta.spawn_depth == null ? 0 : agentMeta.spawn_depth,
      parentAgentId: agentMeta.parent_agent_id || null,
      autoSpawned: agentMeta.auto_spawned || false
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching agent config');
  }
});

// Only the owner's API key may replace an agent's permission ceiling. A scoped
// runtime token can select within its ceiling, but cannot grant itself access.
router.post('/runtime-permissions', async (req, res) => {
  if (req.authContext?.type !== 'api_key') {
    return res.status(403).json({ error: { code: 'OWNER_KEY_REQUIRED', message: 'Use the owner API key to save CLI permission grants.' } });
  }
  try {
    const { agentName, allowedPermissions, config } = req.body;
    const nameValidation = validateAgentName(agentName);
    if (!nameValidation.valid) return validationError(res, nameValidation.message);
    if (!allowedPermissions || typeof allowedPermissions !== 'object' || Array.isArray(allowedPermissions) ||
        JSON.stringify(allowedPermissions).length > 32768 ||
        Object.keys(allowedPermissions).some(key => !SUPPORTED_PROVIDERS.has(key) && !['codex-cli', 'inter_agent', 'project_path'].includes(key))) {
      return validationError(res, 'Provide a valid CLI permission grant.');
    }
    const agent = await findAgentByName(req.user.userId, agentName);
    if (!agent) return res.status(404).json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found for the authenticated owner.' } });
    const state = await loadAgentRuntimeState({ agentId: agent.agent_id, agentName });
    const selected = {};
    for (const key of ['model_provider', 'model', 'approval_mode', 'sandbox_mode', 'thinking_effort']) {
      if (config?.[key] !== undefined) selected[key] = config[key];
    }
    const validation = require('../utils/runOverrides').validateRunOverrides(selected, allowedPermissions);
    if (!validation.valid) return validationError(res, validation.message);
    const nextConfig = { ...state.config, ...(validation.value || {}), updated_at: new Date().toISOString() };
    if (typeof config?.project_path === 'string' && config.project_path.length <= 4096) nextConfig.project_path = config.project_path;
    await persistAgentRuntimeState({ agentId: agent.agent_id, config: nextConfig, allowedPermissions });
    syncRuntimeStateToFilesystem({ agentDir: state.agentDir, config: nextConfig, allowedPermissions });
    return res.json({ config: nextConfig, allowedPermissions });
  } catch (error) { return handleDatabaseError(res, error, 'saving owner CLI permissions'); }
});

/**
 * PUT /api/agent/config
 * Update agent configuration (validates against allowed permissions)
 * 
 * Request body:
 * - agentName: string (required) - Name of the agent
 * - model_provider: string (optional) - Provider to use
 * - model: string (optional) - Model to use
 * - approval_mode: string (optional) - Approval mode
 * - sandbox_mode: string (optional) - Sandbox mode
 * 
 * Response: 200 OK
 * - config: updated agent config
 */
router.put('/config', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName, model_provider, model, approval_mode, sandbox_mode, thinking_effort } = req.body;
    const normalizedSandboxMode = sandbox_mode === 'danger-full-access' ? 'none' : sandbox_mode;
    if (thinking_effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(thinking_effort)) {
      return validationError(res, 'thinking_effort must be low, medium, high, xhigh, or max');
    }
    // NOTE: project_path is intentionally NOT settable from frontend for security
    // It can only be configured via CLI at agent creation time

    if (!agentName) {
      return validationError(res, 'agentName is required');
    }

    const agentNameValidation = validateAgentName(agentName);
    if (!agentNameValidation.valid) {
      return validationError(res, agentNameValidation.message);
    }

    const agent = await findAgentByName(userId, agentName);
    if (!agent) {
      return res.status(404).json({
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'Agent not found for the authenticated user'
        }
      });
    }

    const hasConfigUpdates = Boolean(
      model_provider !== undefined
      || model !== undefined
      || approval_mode !== undefined
      || normalizedSandboxMode !== undefined
      || thinking_effort !== undefined
    );
    const runtimeState = await loadAgentRuntimeState({
      userId,
      agentId: agent.agent_id,
      agentName,
      defaults: DEFAULT_AGENT_API_CONFIG
    });
    let config = { ...runtimeState.config };
    const allowedPermissions = runtimeState.allowedPermissions;

    if (hasConfigUpdates) {
      // Validate against allowed permissions if they exist
      const allowedProviders = Object.keys(allowedPermissions).filter(
        (key) => !['inter_agent', 'project_path'].includes(key)
      );
      const hasPermissionRestrictions = allowedProviders.length > 0;
      if (hasPermissionRestrictions) {
        const requestedProvider = model_provider || config.model_provider;

        // Validate provider is allowed
        if (requestedProvider && !allowedPermissions[requestedProvider]) {
          return res.status(400).json({
            error: {
              code: 'PERMISSION_DENIED',
              message: `Provider '${requestedProvider}' is not allowed by your CLI permissions.`,
              allowedProviders
            }
          });
        }

        // Validate provider-specific permissions
        const providerPerms = allowedPermissions[requestedProvider] || {};

        if (requestedProvider === 'codex' || requestedProvider === 'default' || requestedProvider === 'ollama' || requestedProvider === 'openrouter') {
          // Validate sandbox mode
          const allowedSandboxes = providerPerms['--sandbox'] || [];
          if (allowedSandboxes.length > 0 && normalizedSandboxMode) {
            const sandboxValue = normalizedSandboxMode === 'none' ? 'danger-full-access' : normalizedSandboxMode;
            if (!allowedSandboxes.includes(sandboxValue)) {
              return res.status(400).json({
                error: {
                  code: 'PERMISSION_DENIED',
                  message: `Sandbox mode '${sandboxValue}' is not allowed.`,
                  allowedModes: allowedSandboxes
                }
              });
            }
          }

          // Validate bypass mode
          if (approval_mode === 'full-auto' && normalizedSandboxMode === 'none') {
            const bypassAllowed = providerPerms['--dangerously-bypass-approvals-and-sandbox'] === true;
            if (!bypassAllowed) {
              return res.status(400).json({
                error: {
                  code: 'PERMISSION_DENIED',
                  message: 'Full bypass mode (--dangerously-bypass-approvals-and-sandbox) is not allowed.'
                }
              });
            }
          }
        } else if (requestedProvider === 'claude') {
          // Validate permission mode
          const allowedModes = providerPerms['--permission-mode'] || [];
          if (allowedModes.length > 0 && approval_mode) {
            if (!allowedModes.includes(approval_mode)) {
              return res.status(400).json({
                error: {
                  code: 'PERMISSION_DENIED',
                  message: `Permission mode '${approval_mode}' is not allowed.`,
                  allowedModes: allowedModes
                }
              });
            }
          }

          // Validate skip permissions
          if (normalizedSandboxMode === 'none') {
            const skipAllowed = providerPerms['--dangerously-skip-permissions'] === true;
            if (!skipAllowed) {
              return res.status(400).json({
                error: {
                  code: 'PERMISSION_DENIED',
                  message: 'Skip permissions mode (--dangerously-skip-permissions) is not allowed.'
                }
              });
            }
          }
        } else if (requestedProvider === 'gemini') {
          // Validate sandbox/no-sandbox
          if (normalizedSandboxMode === 'none') {
            const noSandboxAllowed = providerPerms['--no-sandbox'] === true;
            if (!noSandboxAllowed) {
              return res.status(400).json({
                error: {
                  code: 'PERMISSION_DENIED',
                  message: 'No-sandbox mode is not allowed for Gemini.'
                }
              });
            }
          }

          // Validate yolo mode
          if (approval_mode === 'full-auto') {
            const yoloAllowed = providerPerms['--yolo'] === true;
            if (!yoloAllowed) {
              return res.status(400).json({
                error: {
                  code: 'PERMISSION_DENIED',
                  message: 'YOLO mode (--yolo) is not allowed for Gemini.'
                }
              });
            }
          }
        } else if (requestedProvider === 'copilot') {
          // Validate copilot permissions
          if (normalizedSandboxMode === 'none' && approval_mode === 'full-auto') {
            const allowAll = providerPerms['--allow-all'] === true;
            const yoloAllowed = providerPerms['--yolo'] === true;
            if (!allowAll && !yoloAllowed) {
              return res.status(400).json({
                error: {
                  code: 'PERMISSION_DENIED',
                  message: 'Full access mode (--allow-all / --yolo) is not allowed for Copilot.'
                }
              });
            }
          }
        }
      }

      // Read existing config
      // Update only provided fields (project_path is NOT settable from frontend)
      if (model_provider) config.model_provider = model_provider;
      if (model) config.model = model;
      if (approval_mode) config.approval_mode = approval_mode;
      if (normalizedSandboxMode !== undefined) config.sandbox_mode = normalizedSandboxMode;
      if (thinking_effort !== undefined) config.thinking_effort = thinking_effort;
      config.updated_at = new Date().toISOString();
    }

    // Update inter_agent_mode and groups if provided
    const { inter_agent_mode, agent_groups, can_spawn } = req.body;

    if (inter_agent_mode) {
      await query(
        'UPDATE agents SET inter_agent_mode = $1 WHERE agent_id = $2',
        [inter_agent_mode, agent.agent_id]
      );
    }

    // Update can_spawn flag if provided (boolean toggle for agent spawning permission)
    if (typeof can_spawn === 'boolean') {
      await query(
        'UPDATE agents SET can_spawn = $1 WHERE agent_id = $2',
        [can_spawn, agent.agent_id]
      );
    }

    if (Array.isArray(agent_groups)) {
      const client = await getClient();
      try {
        // Sync groups: remove all current memberships and add new ones
        await client.query('BEGIN'); // Use transaction for group updates

        // Remove existing memberships
        await client.query(
          'DELETE FROM agent_group_members WHERE agent_id = $1',
          [agent.agent_id]
        );

        // Add new memberships
        for (const groupName of agent_groups) {
          // Find or create group
          let groupId;
          const groupResult = await client.query(
            'SELECT group_id FROM agent_groups WHERE user_id = $1 AND group_name = $2',
            [userId, groupName]
          );

          if (groupResult.rows.length > 0) {
            groupId = groupResult.rows[0].group_id;
          } else {
            const newGroup = await client.query(
              'INSERT INTO agent_groups (user_id, group_name) VALUES ($1, $2) RETURNING group_id',
              [userId, groupName]
            );
            groupId = newGroup.rows[0].group_id;
          }

          await client.query(
            'INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2)',
            [groupId, agent.agent_id]
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Persist updated config and best-effort sync any local filesystem copy.
    if (hasConfigUpdates) {
      await persistAgentRuntimeState({
        agentId: agent.agent_id,
        config,
        allowedPermissions
      });
      syncRuntimeStateToFilesystem({
        agentDir: runtimeState.agentDir,
        config,
        allowedPermissions
      });
    }

    res.status(200).json({
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      config,
      message: 'Config updated. Changes will take effect at next agent loop iteration.'
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'updating agent config');
  }
});

/**
 * POST /api/agent/stop
 * Request agent to stop current task immediately
 * Creates a stop flag file that the agent runner polls for
 * 
 * Request body:
 * - agentName: string (required) - Name of the agent to stop
 * 
 * Response: 200 OK
 * - message: confirmation that stop was requested
 */
router.post('/stop', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName } = req.body;

    if (!agentName) {
      return validationError(res, 'agentName is required');
    }

    const agentNameValidation = validateAgentName(agentName);
    if (!agentNameValidation.valid) {
      return validationError(res, agentNameValidation.message);
    }

    const agent = await findAgentByName(userId, agentName);
    if (!agent) {
      return res.status(404).json({
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'Agent not found for the authenticated user'
        }
      });
    }

    const stopTimestamp = new Date();

    // 1. Set stop flag in database (works for remote agents via heartbeat)
    await query(
      'UPDATE agents SET stop_requested_at = $1 WHERE agent_id = $2',
      [stopTimestamp, agent.agent_id]
    );

    // 2. Write filesystem stop flag + kill process (best-effort for local agents)
    let processKilled = false;
    let forceKilled = false;
    try {
      const agentFolder = sanitizeFolderName(agentName);
      const agentDir = findAgentChatspaceDir(agentFolder);
      if (agentDir) {
        const stateDir = path.join(agentDir, 'agent_state');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, '.stop_requested'), stopTimestamp.toISOString());

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
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      message: forceKilled
        ? 'Agent process force-killed by failsafe and stop flag set.'
        : processKilled
        ? 'Agent process killed and stop flag set.'
        : 'Stop requested. Agent will halt at next heartbeat.',
      processKilled,
      forceKilled
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'requesting agent stop');
  }
});

/**
 * POST /api/agent/stop/acknowledge
 * Clear a previously requested stop after the runner has honored it.
 *
 * Request body:
 * - agentName: string (required) - Name of the agent acknowledging the stop
 *
 * Response: 200 OK
 * - acknowledged: true when the stop latch was cleared
 */
router.post('/stop/acknowledge', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName } = req.body;

    if (!agentName) {
      return validationError(res, 'agentName is required');
    }

    const agentNameValidation = validateAgentName(agentName);
    if (!agentNameValidation.valid) {
      return validationError(res, agentNameValidation.message);
    }

    const agent = await findAgentByName(userId, agentName);
    if (!agent) {
      return res.status(404).json({
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'Agent not found for the authenticated user'
        }
      });
    }

    await query(
      'UPDATE agents SET stop_requested_at = NULL WHERE agent_id = $1',
      [agent.agent_id]
    );

    try {
      const agentFolder = sanitizeFolderName(agentName);
      const agentDir = findAgentChatspaceDir(agentFolder);
      if (agentDir) {
        fs.rmSync(path.join(agentDir, 'agent_state', '.stop_requested'), { force: true });
      }
    } catch (_err) {
      // Filesystem cleanup is best-effort; DB state is authoritative.
    }

    res.status(200).json({
      acknowledged: true,
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      message: 'Stop request cleared.'
    });
  } catch (error) {
    return handleDatabaseError(res, error, 'acknowledging agent stop');
  }
});

/**
 * POST /api/agent/attachments
 * Upload an encrypted image attachment from an agent
 *
 * Multipart form data fields:
 * - agentName: string (required) - Name of the agent (agents identify by name)
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
 * GET /api/agent/attachments/:attachmentId
 * Download an encrypted attachment
 *
 * Path parameters:
 * - attachmentId: string (required) - UUID of the attachment
 *
 * Authorization:
 * - Uses API key authentication
 * - Agent associated with attachment must belong to authenticated user
 * - Returns 404 for both missing and unauthorized (to avoid leaking existence)
 *
 * Response: 200 OK
 * - Body: Raw encrypted bytes (ciphertext)
 * - Headers:
 *   - Content-Type: application/octet-stream
 *   - Content-Length: <size in bytes>
 *   - Cache-Control: private, max-age=3600
 *   - Content-Disposition: inline; filename="<sanitized_filename>"
 *
 * Error responses:
 * - 400: Invalid attachment ID format
 * - 404: Attachment not found or agent doesn't have access
 * - 500: Storage error
 */
router.get('/attachments/:attachmentId', downloadAttachment);

/**
 * GET /api/agent/cli-script
 * Generate and return the personalized CLI script for the authenticated user
 *
 * Authentication: Requires API key via X-API-Key header
 *
 * Response: 200 OK (text/plain)
 * - Returns the full bash script with embedded API key and encryption salt
 *
 * Error responses:
 * - 401: Invalid or missing API key
 * - 500: Script generation error
 */
router.get('/cli-script', async (req, res) => {
  try {
    const user = req.user || {};
    if (!user.apiKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    const apiKey = user.apiKey;

    // Encryption is mandatory — auto-provision salt for legacy users who don't have one
    let encryptionSalt = typeof user.encryptionSalt === 'string' ? user.encryptionSalt : null;
    if (!encryptionSalt) {
      try {
        const { generateEncryptionSalt } = require('../utils/encryptionHelper');
        encryptionSalt = generateEncryptionSalt();
        const { query: dbQuery } = require('../db/connection');
        await dbQuery('UPDATE users SET encryption_salt = $1 WHERE user_id = $2', [encryptionSalt, user.userId]);
        logInfo('cli-script.auto_provision_salt', { userId: user.userId });
      } catch (saltErr) {
        logError('cli-script.auto_provision_salt_failed', { error: saltErr.message });
      }
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const script = generateMainCLIScript(apiKey, baseUrl, encryptionSalt);
    // Additive integrity header: SHA-256 of the exact response body. New
    // bootstrap clients verify this against the raw download; older clients
    // ignore the unknown header, so this is fully backward-compatible.
    const scriptSha256 = crypto.createHash('sha256').update(script, 'utf8').digest('hex');
    res.set('X-Script-SHA256', scriptSha256);
    res.type('text/plain').send(script);
  } catch (error) {
    console.error('CLI script generation error:', error);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({
      error: 'Failed to generate script',
      details: isProd ? undefined : (error && error.message ? error.message : 'Unknown error')
    });
  }
});

// =============================================================================
// Inter-Agent Communication Endpoints
// =============================================================================

/**
 * GET /api/agent/discover
 * List agents that the calling agent is allowed to communicate with
 *
 * Headers:
 * - X-Agent-Name: string (required) - Name of the calling agent
 *
 * Response: 200 OK
 * - agents: array of agent objects that caller can communicate with
 *   - agentId: string - UUID of the agent
 *   - agentName: string - Name of the agent
 *   - agentType: string - Type ('standard' or 'news_feed')
 *   - isOnline: boolean - True if last_seen_at within 5 minutes
 *   - lastSeenAt: string - ISO 8601 timestamp of last activity
 *   - isMe: boolean - True if this agent is the calling agent
 *   - groups: array - Group names this agent belongs to
 *   - interAgentMode: string - 'disabled', 'listen_all', or 'groups'
 */
router.get('/discover', async (req, res) => {
  try {
    const userId = req.user.userId;
    const myAgentName = req.headers['x-agent-name'];

    // Get calling agent's inter-agent permissions
    let myInterAgentMode = 'disabled';
    let myGroups = [];

    if (myAgentName) {
      // DB-only: rely on agents + group membership tables
    }

    // Look up the agent and its mode in one go
    let myAgentId = null;

    if (myAgentName) {
      const agent = await findAgentByName(userId, myAgentName);
      if (agent) {
        myAgentId = agent.agent_id;
        // Check if inter_agent_mode is in the agent object (need to ensure findAgentByName returns it or query it)
        const modeResult = await query(
          'SELECT inter_agent_mode FROM agents WHERE agent_id = $1',
          [myAgentId]
        );
        if (modeResult.rows.length > 0 && modeResult.rows[0].inter_agent_mode) {
          myInterAgentMode = modeResult.rows[0].inter_agent_mode;
        }

        // Get groups
        const groupsResult = await query(
          `SELECT g.group_name 
                  FROM agent_group_members gm
                  JOIN agent_groups g ON gm.group_id = g.group_id
                  WHERE gm.agent_id = $1`,
          [myAgentId]
        );
        myGroups = groupsResult.rows.map(r => r.group_name);
      }
    }

    // If caller has inter-agent disabled, return empty list (can't see anyone)
    if (myInterAgentMode === 'disabled') {
      return res.json({ agents: [], myInterAgentMode: 'disabled' });
    }

    // Get all agents first (keep query simple for pg-mem compatibility in tests)
    const result = await query(`
      SELECT 
        a.agent_id,
        a.agent_name,
        a.agent_type,
        a.last_seen_at,
        a.inter_agent_mode,
        CASE
          -- last_seen_at is TIMESTAMP (no timezone). Cast NOW() (timestamptz) to TIMESTAMP
          -- to avoid type-cast issues in pg-mem during tests.
          WHEN last_seen_at > (NOW()::timestamp - INTERVAL '5 minutes') THEN true
          ELSE false
        END as is_online
      FROM agents a
      WHERE a.user_id = $1
      ORDER BY a.agent_name ASC
    `, [userId]);

    // Load all group memberships in a second pass
    const groupsByAgentId = new Map();
    const groupsResult = await query(
      `SELECT gm.agent_id, g.group_name
       FROM agent_group_members gm
       JOIN agent_groups g ON gm.group_id = g.group_id
       JOIN agents a ON a.agent_id = gm.agent_id
       WHERE a.user_id = $1`,
      [userId]
    );

    for (const row of groupsResult.rows) {
      if (!groupsByAgentId.has(row.agent_id)) {
        groupsByAgentId.set(row.agent_id, []);
      }
      groupsByAgentId.get(row.agent_id).push(row.group_name);
    }

    // Filter agents based on caller's permissions
    const filteredAgents = [];

    for (const row of result.rows) {
      // Skip self
      if (row.agent_name === myAgentName) {
        const myRowGroups = groupsByAgentId.get(row.agent_id) || [];
        filteredAgents.push({
          agentId: row.agent_id,
          agentName: row.agent_name,
          agentType: row.agent_type,
          isOnline: row.is_online,
          lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
          isMe: true,
          groups: myRowGroups,
          interAgentMode: myInterAgentMode
        });
        continue;
      }

      // Use DB values
      const targetInterAgentMode = row.inter_agent_mode || 'disabled';
      const targetGroups = groupsByAgentId.get(row.agent_id) || [];

      // Skip agents with inter-agent disabled
      if (targetInterAgentMode === 'disabled') {
        continue;
      }

      // Check if caller can communicate with target
      let canCommunicate = false;

      if (myInterAgentMode === 'listen_all') {
        // listen_all can see all agents that have inter-agent enabled
        canCommunicate = true;
      } else if (myInterAgentMode === 'groups') {
        // groups mode can see:
        // 1. Agents with listen_all mode
        // 2. Agents in at least one of the same groups
        if (targetInterAgentMode === 'listen_all') {
          canCommunicate = true;
        } else if (targetInterAgentMode === 'groups') {
          // Check for shared groups
          const sharedGroups = myGroups.filter(g => targetGroups.includes(g));
          canCommunicate = sharedGroups.length > 0;
        }
      }

      if (canCommunicate) {
        filteredAgents.push({
          agentId: row.agent_id,
          agentName: row.agent_name,
          agentType: row.agent_type,
          isOnline: row.is_online,
          lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
          isMe: false,
          groups: targetGroups,
          interAgentMode: targetInterAgentMode
        });
      }
    }

    res.json({
      agents: filteredAgents,
      myInterAgentMode,
      myGroups
    });
  } catch (error) {
    handleDatabaseError(res, error, 'agent discovery');
  }
});

/**
 * POST /api/agent/messages/direct
 * Send a message directly to another agent
 *
 * Headers:
 * - X-Agent-Name: string (required) - Name of the sending agent
 *
 * Request body:
 * - toAgentName: string (required) - Name of the recipient agent
 * - content: string (required) - Message content
 * - priority: 0 | 1 | 2 (optional, default: 0) - 0=normal, 1=attention, 2=urgent
 * - encrypted: boolean (optional, default: false) - Whether content is encrypted
 *
 * Response: 201 Created
 * - status: 'sent'
 * - messageId: string - UUID of the created message
 * - toAgent: string - Name of the recipient agent
 *
 * Error responses:
 * - 400: Validation error (missing fields, invalid agent names)
 * - 429: Rate limit exceeded (too many messages to this agent)
 */
router.post('/messages/direct', async (req, res) => {
  try {
    const { toAgentName, content, priority = 0, encrypted = false, clientMessageId } = req.body;
    if (clientMessageId !== undefined && !isValidUUID(clientMessageId)) {
      return validationError(res, 'clientMessageId must be a UUID');
    }
    const userId = req.user.userId;
    const fromAgentName = req.headers['x-agent-name'];

    // Validate required fields
    if (!fromAgentName) {
      return validationError(res, 'X-Agent-Name header is required');
    }
    if (!toAgentName) {
      return validationError(res, 'toAgentName is required');
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return validationError(res, 'content is required and must be non-empty');
    }

    // Validate agent names
    const fromValidation = validateAgentName(fromAgentName);
    if (!fromValidation.valid) {
      return validationError(res, `Invalid sender agent name: ${fromValidation.message}`);
    }
    const toValidation = validateAgentName(toAgentName);
    if (!toValidation.valid) {
      return validationError(res, `Invalid recipient agent name: ${toValidation.message}`);
    }

    // Cannot send to self
    if (fromAgentName.trim() === toAgentName.trim()) {
      return validationError(res, 'Cannot send message to self');
    }

    // Validate priority
    const priorityValidation = validatePriority(priority);
    if (!priorityValidation.valid) {
      return validationError(res, priorityValidation.message);
    }

    // Find sender and recipient agents (must belong to same user)
    const agentsResult = await query(`
      SELECT agent_id, agent_name FROM agents
      WHERE user_id = $1 AND agent_name IN ($2, $3)
    `, [userId, fromAgentName.trim(), toAgentName.trim()]);

    const senderAgent = agentsResult.rows.find(a => a.agent_name === fromAgentName.trim());
    const recipientAgent = agentsResult.rows.find(a => a.agent_name === toAgentName.trim());

    if (!senderAgent) {
      return validationError(res, 'Sender agent not found');
    }
    if (!recipientAgent) {
      return validationError(res, 'Recipient agent not found');
    }

    // Check inter-agent communication permissions (DB-only)
    const getAgentInterAgentConfig = async (agentName) => {
      const agent = await findAgentByName(userId, agentName);
      if (!agent) {
        return { mode: 'disabled', groups: [] };
      }

      const modeResult = await query(
        'SELECT inter_agent_mode FROM agents WHERE agent_id = $1',
        [agent.agent_id]
      );
      const mode = modeResult.rows.length > 0 && modeResult.rows[0].inter_agent_mode
        ? modeResult.rows[0].inter_agent_mode
        : 'disabled';

      const groupsResult = await query(
        `SELECT g.group_name
         FROM agent_group_members gm
         JOIN agent_groups g ON gm.group_id = g.group_id
         WHERE gm.agent_id = $1`,
        [agent.agent_id]
      );

      return { mode, groups: groupsResult.rows.map(r => r.group_name) };
    };

    const senderConfig = await getAgentInterAgentConfig(fromAgentName.trim());
    const recipientConfig = await getAgentInterAgentConfig(toAgentName.trim());

    // Both agents must have inter-agent enabled
    if (senderConfig.mode === 'disabled') {
      return res.status(403).json({
        error: {
          code: 'INTER_AGENT_DISABLED',
          message: 'Your agent does not have inter-agent communication enabled'
        }
      });
    }
    if (recipientConfig.mode === 'disabled') {
      return res.status(403).json({
        error: {
          code: 'RECIPIENT_INTER_AGENT_DISABLED',
          message: 'Recipient agent does not have inter-agent communication enabled'
        }
      });
    }

    // Check if communication is allowed based on modes
    let canCommunicate = false;

    if (senderConfig.mode === 'listen_all') {
      // listen_all can send to anyone with inter-agent enabled
      canCommunicate = true;
    } else if (senderConfig.mode === 'groups') {
      // groups mode can send to:
      // 1. Agents with listen_all mode (they accept from anyone)
      // 2. Agents in at least one of the same groups
      if (recipientConfig.mode === 'listen_all') {
        canCommunicate = true;
      } else if (recipientConfig.mode === 'groups') {
        const sharedGroups = senderConfig.groups.filter(g => recipientConfig.groups.includes(g));
        canCommunicate = sharedGroups.length > 0;
      }
    }

    if (!canCommunicate) {
      return res.status(403).json({
        error: {
          code: 'NO_SHARED_GROUPS',
          message: 'Cannot send message: no shared communication groups with recipient'
        }
      });
    }

    // Enforce encryption on agent-to-agent DMs
    if (!encrypted) {
      return res.status(400).json({
        error: {
          code: 'ENCRYPTION_REQUIRED',
          message: 'Agent-to-agent messages must be encrypted. Ensure your agent has a password and encryption salt configured.'
        }
      });
    }

    // A bridge may retry after losing the HTTP response. Use the existing UUID
    // primary key for optional idempotency, without changing legacy senders.
    const matchesRetry = row => row.sender_agent_id === senderAgent.agent_id
      && row.recipient_agent_id === recipientAgent.agent_id
      && row.content === content && row.encrypted === true;
    if (clientMessageId) {
      const previous = await query('SELECT * FROM agent_messages WHERE agent_message_id = $1', [clientMessageId]);
      if (previous.rows.length) {
        if (!matchesRetry(previous.rows[0])) {
          return res.status(409).json({ error: { code: 'MESSAGE_ID_CONFLICT', message: 'clientMessageId is already in use' } });
        }
        return res.json({ status: 'sent', messageId: clientMessageId, toAgent: toAgentName.trim(), idempotent: true });
      }
    }

    // Rate limiting: check recent messages from sender to recipient (max 10 per minute)
    const recentMessages = await query(`
      SELECT COUNT(*) as count FROM agent_messages
      WHERE sender_agent_id = $1 
        AND recipient_agent_id = $2 
        AND created_at > (NOW()::timestamp - INTERVAL '1 minute')
    `, [senderAgent.agent_id, recipientAgent.agent_id]);

    if (parseInt(recentMessages.rows[0].count, 10) >= 10) {
      return res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many messages to this agent. Please wait before sending more.'
        }
      });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Insert the message
      const insertResult = await client.query(`
        INSERT INTO agent_messages (sender_agent_id, recipient_agent_id, content, encrypted, priority, agent_message_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (agent_message_id) DO NOTHING
        RETURNING agent_message_id
      `, [senderAgent.agent_id, recipientAgent.agent_id, content, encrypted === true, priorityValidation.value, clientMessageId || crypto.randomUUID()]);
      if (!insertResult.rows.length) {
        const previous = await client.query('SELECT * FROM agent_messages WHERE agent_message_id = $1', [clientMessageId]);
        if (!previous.rows.length || !matchesRetry(previous.rows[0])) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: { code: 'MESSAGE_ID_CONFLICT', message: 'clientMessageId is already in use' } });
        }
        await client.query('COMMIT');
        return res.json({ status: 'sent', messageId: clientMessageId, toAgent: toAgentName.trim(), idempotent: true });
      }

      // Update last_seen_at for sender agent
      await client.query('UPDATE agents SET last_seen_at = NOW()::timestamp WHERE agent_id = $1', [senderAgent.agent_id]);

      // Note: Inter-agent messages are now fetched directly from agent_messages table
      // No need to create redundant user_messages entries

      await client.query('COMMIT');

      let delivery = {
        mode: 'poll_only',
        recipientHost: 'remote_or_unregistered',
        wakeSignalSent: false,
        note: 'Recipient will receive the DM on its next poll if no local runner folder is available on this host.'
      };

      // Write a signal file to wake up the recipient agent's polling loop early
      try {
        const recipientFolder = sanitizeFolderName(toAgentName.trim());
        const signalPath = path.join(getChatspaceRoot(), recipientFolder, 'agent_state', '.dm_pending');
        fs.writeFileSync(signalPath, `from=${fromAgentName.trim()}\ntime=${new Date().toISOString()}\n`);
        delivery = {
          mode: 'instant_wake',
          recipientHost: 'local',
          wakeSignalSent: true,
          note: 'Wake signal written to the local agent runner folder.'
        };
      } catch (_signalErr) {
        // Non-critical: agent will still pick up the DM on next poll cycle
      }

      res.status(201).json({
        status: 'sent',
        messageId: insertResult.rows[0].agent_message_id,
        toAgent: toAgentName.trim(),
        delivery
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    handleDatabaseError(res, error, 'sending direct message');
  }
});

/**
 * GET /api/agent/messages/direct
 * Poll for messages from other agents
 *
 * Headers:
 * - X-Agent-Name: string (required) - Name of the polling agent
 *
 * Query parameters:
 * - since: ISO 8601 timestamp (optional) - Only return messages after this time
 * - fromAgent: string (optional) - Filter messages by sender agent name
 *
 * Response: 200 OK
 * - messages: array of message objects
 *   - messageId: string - UUID of the message
 *   - fromAgent: string - Name of the sender agent
 *   - fromAgentId: string - UUID of the sender agent
 *   - content: string - Message content
 *   - encrypted: boolean - Whether content is encrypted
 *   - priority: number - Priority level (0, 1, or 2)
 *   - timestamp: string - ISO 8601 timestamp of when message was sent
 */
router.get('/messages/direct', agentPollingRateLimiter, async (req, res) => {
  try {
    if (req.query.markRead !== undefined && !['true', 'false'].includes(req.query.markRead)) {
      return validationError(res, 'markRead must be true or false');
    }
    const markRead = req.query.markRead !== 'false';
    const userId = req.user.userId;
    const myAgentName = req.headers['x-agent-name'];
    const { since, fromAgent } = req.query;

    if (!myAgentName) {
      return validationError(res, 'X-Agent-Name header is required');
    }

    // Find the agent making the request
    const myAgent = await findAgentByName(userId, myAgentName);
    if (!myAgent) {
      return validationError(res, 'Agent not found');
    }

    // Update last_seen_at for this agent
    await query('UPDATE agents SET last_seen_at = NOW()::timestamp WHERE agent_id = $1', [myAgent.agent_id]);

    // Build query conditions
    const queryParams = [myAgent.agent_id];
    let paramIndex = 2;
    let whereConditions = ['am.recipient_agent_id = $1', 'am.read_at IS NULL'];

    // Filter by since timestamp
    if (since) {
      const timestampValidation = validateTimestamp(since);
      if (!timestampValidation.valid) {
        return validationError(res, timestampValidation.message);
      }
      const formattedSince = formatTimestampForDatabase(timestampValidation.date);
      if (!formattedSince) {
        return validationError(res, 'Invalid timestamp format');
      }
      whereConditions.push(`am.created_at > $${paramIndex}`);
      queryParams.push(formattedSince);
      paramIndex++;
    }

    // Filter by sender agent
    if (fromAgent) {
      const fromAgentValidation = validateAgentName(fromAgent);
      if (!fromAgentValidation.valid) {
        return validationError(res, fromAgentValidation.message);
      }
      const senderAgent = await findAgentByName(userId, fromAgent);
      if (senderAgent) {
        whereConditions.push(`am.sender_agent_id = $${paramIndex}`);
        queryParams.push(senderAgent.agent_id);
        paramIndex++;
      } else {
        // No messages from non-existent agent
        return res.json({ messages: [], poll: getPollAdvice(req, false) });
      }
    }

    // Fetch unread messages
    const result = await query(`
      SELECT 
        am.agent_message_id,
        am.content,
        am.encrypted,
        am.priority,
        am.created_at,
        sender.agent_id as sender_agent_id,
        sender.agent_name as sender_agent_name
      FROM agent_messages am
      JOIN agents sender ON am.sender_agent_id = sender.agent_id
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY am.created_at ASC
    `, queryParams);

    // Mark messages as read
    if (markRead && result.rows.length > 0) {
      const messageIds = result.rows.map(row => row.agent_message_id);
      // Prefer bulk updates, but fall back to per-row updates for test DBs (pg-mem)
      // that don't fully support `ANY($1)` array binding semantics.
      const updated = await query(
        `UPDATE agent_messages SET read_at = NOW()::timestamp WHERE agent_message_id = ANY($1)`,
        [messageIds]
      );

      if (SHOULD_USE_TEST_DB_BULK_FALLBACK && ((updated && updated.rowCount) || 0) !== messageIds.length) {
        for (const messageId of messageIds) {
          await query(
            'UPDATE agent_messages SET read_at = NOW()::timestamp WHERE agent_message_id = $1',
            [messageId]
          );
        }
      }
    }

    const messages = result.rows.map(row => ({
        messageId: row.agent_message_id,
        fromAgent: row.sender_agent_name,
        fromAgentId: row.sender_agent_id,
        content: row.content,
        encrypted: row.encrypted || false,
        priority: row.priority,
        timestamp: row.created_at.toISOString()
    }));

    res.json({
      messages,
      poll: getPollAdvice(req, messages.length > 0)
    });
  } catch (error) {
    handleDatabaseError(res, error, 'polling direct messages');
  }
});
// =============================================================================
// Agent Groups Endpoints (for inter-agent communication control)
// =============================================================================

/**
 * GET /api/agent/groups
 * List all agent groups for the authenticated user
 */
router.get('/groups', async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await query(`
      SELECT 
        g.group_id,
        g.group_name,
        g.description,
        g.created_at,
        COUNT(gm.agent_id) as member_count
      FROM agent_groups g
      LEFT JOIN agent_group_members gm ON g.group_id = gm.group_id
      WHERE g.user_id = $1
      GROUP BY g.group_id, g.group_name, g.description, g.created_at
      ORDER BY g.group_name ASC
    `, [userId]);

    res.json({
      groups: result.rows.map(row => ({
        groupId: row.group_id,
        groupName: row.group_name,
        description: row.description,
        memberCount: parseInt(row.member_count, 10),
        createdAt: row.created_at ? row.created_at.toISOString() : null
      }))
    });
  } catch (error) {
    handleDatabaseError(res, error, 'listing agent groups');
  }
});

/**
 * POST /api/agent/groups
 * Create a new agent group with optional encryption salt for DMs
 * 
 * Request body:
 * - groupName: string (required)
 * - description: string (optional)
 * - encryptionSalt: string (optional) - Base64-encoded salt for group DM encryption
 */
router.post('/groups', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupName, description, encryptionSalt } = req.body;

    if (!groupName || typeof groupName !== 'string' || groupName.trim().length === 0) {
      return validationError(res, 'groupName is required');
    }
    if (groupName.length > 100) {
      return validationError(res, 'groupName must be 100 characters or less');
    }

    const existing = await query(
      'SELECT group_id FROM agent_groups WHERE user_id = $1 AND group_name = $2',
      [userId, groupName.trim()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: { code: 'GROUP_EXISTS', message: 'A group with this name already exists' }
      });
    }

    const result = await query(
      'INSERT INTO agent_groups (user_id, group_name, description, encryption_salt) VALUES ($1, $2, $3, $4) RETURNING group_id',
      [userId, groupName.trim(), description || null, encryptionSalt || null]
    );

    res.status(201).json({
      groupId: result.rows[0].group_id,
      groupName: groupName.trim(),
      hasEncryption: !!encryptionSalt
    });
  } catch (error) {
    handleDatabaseError(res, error, 'creating agent group');
  }
});

/**
 * POST /api/agent/groups/:groupId/join
 * Add an agent to a group
 * 
 * Returns the group's encryption salt for DM encryption
 */
router.post('/groups/:groupId/join', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId } = req.params;
    const agentName = req.headers['x-agent-name'];

    if (!agentName) {
      return validationError(res, 'X-Agent-Name header is required');
    }
    if (!groupId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      return validationError(res, 'Invalid groupId format');
    }

    const groupResult = await query(
      'SELECT group_id, group_name, encryption_salt FROM agent_groups WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: { code: 'GROUP_NOT_FOUND', message: 'Group not found' } });
    }

    const agentNameValidation = validateAgentName(agentName);
    if (!agentNameValidation.valid) {
      return validationError(res, agentNameValidation.message);
    }

    const agentResult = await query(
      'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_name = $2',
      [userId, agentName.trim()]
    );
    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } });
    }

    await query(
      'INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, agentResult.rows[0].agent_id]
    );

    res.json({
      status: 'joined',
      groupId: groupId,
      groupName: groupResult.rows[0].group_name,
      agentName: agentName.trim(),
      encryptionSalt: groupResult.rows[0].encryption_salt || null
    });
  } catch (error) {
    handleDatabaseError(res, error, 'joining agent group');
  }
});

/**
 * GET /api/agent/groups/:groupId/salt
 * Get the encryption salt for a group (for DM encryption)
 * 
 * Only returns salt if the calling agent is a member of the group
 */
router.get('/groups/:groupId/salt', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId } = req.params;
    const agentName = req.headers['x-agent-name'];

    if (!agentName) {
      return validationError(res, 'X-Agent-Name header is required');
    }
    if (!groupId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      return validationError(res, 'Invalid groupId format');
    }

    // Find the agent
    const agentResult = await query(
      'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_name = $2',
      [userId, agentName.trim()]
    );
    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } });
    }

    // Check if agent is a member of the group
    const memberResult = await query(`
      SELECT g.group_name, g.encryption_salt 
      FROM agent_groups g
      JOIN agent_group_members gm ON g.group_id = gm.group_id
      WHERE g.group_id = $1 AND g.user_id = $2 AND gm.agent_id = $3
    `, [groupId, userId, agentResult.rows[0].agent_id]);

    if (memberResult.rows.length === 0) {
      return res.status(403).json({
        error: { code: 'NOT_A_MEMBER', message: 'Agent is not a member of this group' }
      });
    }

    res.json({
      groupId: groupId,
      groupName: memberResult.rows[0].group_name,
      encryptionSalt: memberResult.rows[0].encryption_salt || null
    });
  } catch (error) {
    handleDatabaseError(res, error, 'getting group salt');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Agent Spawning Endpoints
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/agent/spawn
 * Spawn a new independent child agent.
 *
 * Headers:
 * - X-Agent-Name: string (required) - Name of the parent agent requesting the spawn
 *
 * Request body:
 * - childAgentName: string (required) - Name for the new child agent
 * - initialInstructions: string (optional) - Instructions to seed the child with
 * - modelProvider: string (optional) - AI provider override (default: inherit parent)
 * - model: string (optional) - Model name override (default: inherit parent)
 * - projectPath: string (optional) - Working directory override on the same machine
 * - canSpawn: boolean (optional, default: false) - Allow child to spawn its own children
 * - groups: string[] (optional) - Group IDs/names. Omit to inherit parent groups; [] leaves child ungrouped
 *
 * Response: 201 Created
 * - success: true
 * - childAgent: { agentId, agentName, spawnDepth, parentAgentId, createdAt }
 */
router.post('/spawn', async (req, res) => {
  try {
    const userId = req.user.userId;
    const parentAgentName = req.headers['x-agent-name'];

    if (!parentAgentName) {
      return validationError(res, 'X-Agent-Name header is required to identify the parent agent');
    }

    const { childAgentName, initialInstructions, modelProvider, model, projectPath, canSpawn, parentPassword, groups } = req.body;

    if (projectPath != null && (typeof projectPath !== 'string' || projectPath.trim().length === 0)) {
      return validationError(res, 'projectPath must be a non-empty string when provided');
    }

    if (groups !== undefined && (!Array.isArray(groups) || groups.length > 20 || groups.some(
      group => typeof group !== 'string' || group.trim().length === 0 || group.trim().length > 100
    ))) {
      return validationError(res, 'groups must be an array of up to 20 non-empty group IDs or names');
    }

    // Validate child agent name
    if (!childAgentName || typeof childAgentName !== 'string' || childAgentName.trim().length === 0) {
      return validationError(res, 'childAgentName is required and must be a non-empty string');
    }

    const childNameValidation = validateAgentName(childAgentName);
    if (!childNameValidation.valid) {
      return validationError(res, `Invalid childAgentName: ${childNameValidation.message}`);
    }

    // Resolve parent agent
    const parentAgent = await findAgentByName(userId, parentAgentName);
    if (!parentAgent) {
      return res.status(404).json({
        error: { code: 'PARENT_NOT_FOUND', message: `Parent agent "${parentAgentName}" not found` }
      });
    }

    // Spawn the child
    const childAgent = await spawnAgent({
      userId,
      parentAgentId: parentAgent.agent_id,
      childAgentName: childAgentName.trim(),
      initialInstructions: initialInstructions || '',
      modelProvider,
      model,
      projectPath,
      canSpawn: canSpawn === true,
      groupSelectors: groups === undefined ? undefined : groups.map(group => group.trim())
    });

    // Auto-DM: send parent's specific instructions to the child as a DM
    if (initialInstructions && initialInstructions.trim()) {
      try {
        const missionMessage = `Your Mission (from parent):\n\n${initialInstructions.trim()}`;
        let dmContent = missionMessage;
        let dmEncrypted = false;

        // Keep spawn-mission DMs aligned with normal message encryption.
        if (parentPassword && req.user.encryptionSalt) {
          try {
            dmContent = encryptMessage(missionMessage, parentPassword, req.user.encryptionSalt);
            dmEncrypted = true;
          } catch (encErr) {
            console.warn('[agent.spawn.auto_dm] Encryption failed, falling back to plaintext:', encErr.message);
          }
        }

        await query(
          `INSERT INTO agent_messages (sender_agent_id, recipient_agent_id, content, encrypted, priority)
           VALUES ($1, $2, $3, $4, 0)`,
          [parentAgent.agent_id, childAgent.agentId,
          dmContent, dmEncrypted]
        );

        // Wake the child immediately for auto-DM delivery.
        try {
          const recipientFolder = sanitizeFolderName(childAgent.agentName || childAgentName.trim());
          const signalPath = path.join(getChatspaceRoot(), recipientFolder, 'agent_state', '.dm_pending');
          fs.writeFileSync(signalPath, `from=${parentAgentName.trim()}\ntime=${new Date().toISOString()}\n`);
        } catch (_signalErr) {
          // Non-critical: child will pick up the DM on next poll cycle.
        }
      } catch (dmErr) {
        // Non-critical: child still has instructions in AGENT_INSTRUCTIONS.md
        console.warn('[agent.spawn.auto_dm] Failed to send instructions DM:', dmErr.message);
      }
    }

    res.status(201).json({
      success: true,
      childAgent
    });

  } catch (error) {
    if (error instanceof SpawnError || error.name === 'SpawnError') {
      return res.status(400).json({
        error: { code: error.code || 'SPAWN_FAILED', message: error.message }
      });
    }
    handleDatabaseError(res, error, 'spawning agent');
  }
});

/**
 * POST /api/agent/self-terminate
 * Agent requests its own termination. Archives the agent and re-parents children.
 *
 * Headers:
 * - X-Agent-Name: string (required) - Name of the agent requesting termination
 *
 * Request body:
 * - reason: string (optional) - Why the agent is terminating
 * - archiveMessages: boolean (optional, default: true) - Whether to archive messages
 *
 * Response: 200 OK
 * - success: true
 * - archived: boolean
 * - orphanedChildren: number
 * - orphanAction: string ('reassigned_to_parent' | 'promoted_to_root' | 'none')
 */
router.post('/self-terminate', async (req, res) => {
  try {
    const userId = req.user.userId;
    const agentName = req.headers['x-agent-name'];

    if (!agentName) {
      return validationError(res, 'X-Agent-Name header is required');
    }

    const { reason, archiveMessages } = req.body;

    // Resolve agent
    const agent = await findAgentByName(userId, agentName);
    if (!agent) {
      return res.status(404).json({
        error: { code: 'AGENT_NOT_FOUND', message: `Agent "${agentName}" not found` }
      });
    }

    const result = await selfTerminate({
      userId,
      agentId: agent.agent_id,
      reason: reason || null,
      archiveMessages: archiveMessages !== false // default true
    });

    res.json(result);

  } catch (error) {
    if (error instanceof SpawnError || error.name === 'SpawnError') {
      return res.status(400).json({
        error: { code: error.code || 'TERMINATE_FAILED', message: error.message }
      });
    }
    handleDatabaseError(res, error, 'self-terminating agent');
  }
});

/**
 * GET /api/agent/lineage
 * Get the full family tree (ancestors + descendants) for an agent.
 *
 * Headers:
 * - X-Agent-Name: string (required) - Name of the agent
 *
 * Response: 200 OK
 * - ancestors: array of { agent_id, agent_name, parent_agent_id, spawn_depth }
 * - descendants: array of { agent_id, agent_name, parent_agent_id, spawn_depth }
 */
router.get('/lineage', async (req, res) => {
  try {
    const userId = req.user.userId;
    const agentName = req.headers['x-agent-name'] || req.query.agentName;

    if (!agentName) {
      return validationError(res, 'X-Agent-Name header or agentName query param is required');
    }

    const agent = await findAgentByName(userId, agentName);
    if (!agent) {
      return res.status(404).json({
        error: { code: 'AGENT_NOT_FOUND', message: `Agent "${agentName}" not found` }
      });
    }

    const lineage = await getLineage(agent.agent_id);
    res.json(lineage);

  } catch (error) {
    handleDatabaseError(res, error, 'fetching lineage');
  }
});

/**
 * GET /api/agent/children
 * Get direct children of an agent.
 *
 * Headers:
 * - X-Agent-Name: string (required) - Name of the parent agent
 *
 * Response: 200 OK
 * - children: array of { agent_id, agent_name, spawn_depth, can_spawn, auto_spawned, created_at }
 */
router.get('/children', async (req, res) => {
  try {
    const userId = req.user.userId;
    const agentName = req.headers['x-agent-name'] || req.query.agentName;

    if (!agentName) {
      return validationError(res, 'X-Agent-Name header or agentName query param is required');
    }

    const agent = await findAgentByName(userId, agentName);
    if (!agent) {
      return res.status(404).json({
        error: { code: 'AGENT_NOT_FOUND', message: `Agent "${agentName}" not found` }
      });
    }

    const children = await getChildren(agent.agent_id);
    res.json({ children });

  } catch (error) {
    handleDatabaseError(res, error, 'fetching children');
  }
});

// =============================================================================
// Local Chief of Staff install (X-API-Key authenticated)
// =============================================================================
// Mirrors POST /api/user/install-chief-of-staff but accepts X-API-Key auth
// instead of a session cookie, so the agent-cli.sh installer can call it
// from a fresh machine (where there's no browser session). These do NOT
// pass through chiefOfStaffOnly — they're install-time operations gated
// only by the user's own API key.

router.get('/user/install-chief-of-staff/status', async (req, res) => {
  try {
    const agents = await chiefOfStaffService.listChiefsOfStaffForUser(req.user.userId);
    res.json({ agents });
  } catch (error) {
    handleDatabaseError(res, error, 'fetching Chief of Staff install status (apikey)');
  }
});

router.post('/user/install-chief-of-staff', async (req, res) => {
  try {
    const { confirm, userPassword, skipFiles, agentName } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: {
          code: 'INVALID_INPUT',
          message: 'confirm: true is required to install the Local Chief of Staff'
        }
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

    res.status(201).json({ success: true, ...result });
  } catch (error) {
    if (error && error.name === 'ChiefOfStaffError') {
      const status = error.code === 'COS_ALREADY_INSTALLED' ? 409
        : error.code === 'COS_NAME_CONFLICT' ? 409
        : 400;
      return res.status(status).json({
        error: { code: error.code, message: error.message }
      });
    }
    handleDatabaseError(res, error, 'cos install (apikey)');
  }
});

router.post('/user/install-chief-of-staff/files', async (req, res) => {
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

    const { generateChiefOfStaffInstructions } = require('../utils/apiGuideGenerator');
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
    handleDatabaseError(res, error, 'cos files (apikey)');
  }
});

// =============================================================================
// Chief of Staff sub-router  (/api/agent/cos/*)
// =============================================================================
// All routes below require:
//   - X-API-Key (any valid user API key)               -> requireApiKey
//   - X-Agent-Name matching a row with is_chief_of_staff=TRUE
//                                                       -> chiefOfStaffOnly
//
// The middleware attaches req.cosAgent = { agentId, agentName, userId }.

const cosRouter = express.Router();
cosRouter.use(chiefOfStaffOnly);

/**
 * GET /api/agent/cos/roster
 * Returns every agent owned by the calling user with live state.
 */
cosRouter.get('/roster', async (req, res) => {
  try {
    const roster = await chiefOfStaffService.listRoster(req.cosAgent.userId);
    res.json({
      cosAgentId: req.cosAgent.agentId,
      cosAgentName: req.cosAgent.agentName,
      agents: roster,
      generated_at: new Date().toISOString()
    });
  } catch (error) {
    handleDatabaseError(res, error, 'fetching roster');
  }
});

/**
 * POST /api/agent/cos/groups
 * Body: { groupName, description? }
 * Creates a group for the CoS's user. Repeating the same request is safe and
 * returns the existing group instead of creating a duplicate.
 */
cosRouter.post('/groups', async (req, res) => {
  try {
    const { groupName, description } = req.body || {};
    if (typeof groupName !== 'string' || !groupName.trim()) {
      return validationError(res, 'groupName is required');
    }
    const normalizedName = groupName.trim();
    if (normalizedName.length > 100) {
      return validationError(res, 'groupName must be 100 characters or less');
    }
    if (description !== undefined && typeof description !== 'string') {
      return validationError(res, 'description must be a string when provided');
    }

    const existing = await query(
      'SELECT group_id, group_name, description FROM agent_groups WHERE user_id = $1 AND group_name = $2',
      [req.cosAgent.userId, normalizedName]
    );
    if (existing.rows.length) {
      return res.json({
        success: true,
        created: false,
        groupId: existing.rows[0].group_id,
        groupName: existing.rows[0].group_name,
        description: existing.rows[0].description
      });
    }

    const created = await query(
      `INSERT INTO agent_groups (user_id, group_name, description)
       VALUES ($1, $2, $3) RETURNING group_id, group_name, description`,
      [req.cosAgent.userId, normalizedName, description ? description.trim() : null]
    );
    res.status(201).json({
      success: true,
      created: true,
      groupId: created.rows[0].group_id,
      groupName: created.rows[0].group_name,
      description: created.rows[0].description
    });
  } catch (error) {
    handleDatabaseError(res, error, 'cos create-group');
  }
});

/**
 * POST /api/agent/cos/groups/:groupId/members
 * Body: { agentId }. Adds one non-CoS agent to a group owned by this user.
 * Membership insertion is idempotent, so retries never duplicate membership.
 */
cosRouter.post('/groups/:groupId/members', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { agentId } = req.body || {};
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupId)) {
      return validationError(res, 'Invalid groupId format');
    }
    if (typeof agentId !== 'string' || !agentId.trim()) {
      return validationError(res, 'agentId is required');
    }

    const [groupResult, agentResult] = await Promise.all([
      query('SELECT group_id, group_name FROM agent_groups WHERE group_id = $1 AND user_id = $2', [groupId, req.cosAgent.userId]),
      query(
        `SELECT agent_id, agent_name, is_chief_of_staff FROM agents
         WHERE agent_id = $1 AND user_id = $2`,
        [agentId, req.cosAgent.userId]
      )
    ]);
    if (!groupResult.rows.length) {
      return res.status(404).json({ error: { code: 'GROUP_NOT_FOUND', message: 'Group not found' } });
    }
    if (!agentResult.rows.length) {
      return res.status(404).json({ error: { code: 'AGENT_NOT_FOUND', message: 'Target agent not found' } });
    }
    if (agentResult.rows[0].is_chief_of_staff) {
      return res.status(403).json({ error: { code: 'COS_PROTECTED', message: 'A Chief of Staff cannot be added through this endpoint' } });
    }

    const inserted = await query(
      `INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING agent_id`,
      [groupId, agentId]
    );
    res.json({
      success: true,
      joined: inserted.rows.length === 1,
      groupId,
      groupName: groupResult.rows[0].group_name,
      agentId,
      agentName: agentResult.rows[0].agent_name
    });
  } catch (error) {
    handleDatabaseError(res, error, 'cos add-group-member');
  }
});

/**
 * POST /api/agent/cos/spawn-child
 * Body: { name, role?, initialInstructions?, runtimeConfig?, canSpawn?, projectPath?, parentPassword?, groups? }
 * Creates a child agent (parent = CoS) and writes its chatspace folder.
 */
cosRouter.post('/spawn-child', async (req, res) => {
  try {
    const { name, role, initialInstructions, runtimeConfig, canSpawn, projectPath, parentPassword, groups } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return validationError(res, 'name is required (the new agent name)');
    }
    const childNameValidation = validateAgentName(name);
    if (!childNameValidation.valid) {
      return validationError(res, `Invalid name: ${childNameValidation.message}`);
    }
    if (groups !== undefined && (!Array.isArray(groups) || groups.length > 20 || groups.some(
      group => typeof group !== 'string' || group.trim().length === 0 || group.trim().length > 100
    ))) {
      return validationError(res, 'groups must be an array of up to 20 non-empty group IDs or names');
    }

    const composedInstructions = [
      role ? `Role: ${role.trim()}` : null,
      initialInstructions ? initialInstructions.trim() : null
    ].filter(Boolean).join('\n\n');

    const child = await spawnAgent({
      userId: req.cosAgent.userId,
      parentAgentId: req.cosAgent.agentId,
      childAgentName: name.trim(),
      initialInstructions: composedInstructions,
      modelProvider: runtimeConfig && runtimeConfig.model_provider,
      model: runtimeConfig && runtimeConfig.model,
      projectPath,
      canSpawn: canSpawn === true,
      groupSelectors: groups === undefined ? undefined : groups.map(group => group.trim())
    });

    let agentDir = null;
    try {
      agentDir = chiefOfStaffService.writeChildAgentFiles({
        agentName: child.agentName,
        agentId: child.agentId,
        initialInstructions: composedInstructions,
        runtimeConfig: child.runtime && child.runtime.config,
        allowedPermissions: child.runtime && child.runtime.allowedPermissions,
        credentials: {
          apiKey: req.headers['x-api-key'] || '',
          encryptionSalt: req.user.encryptionSalt || '',
          apiBase: `${req.protocol}://${req.get('host')}/api`,
          userPassword: parentPassword || ''
        }
      });
    } catch (fileErr) {
      console.warn('[cos.spawn_child.write_files]', fileErr.message);
    }

    if (composedInstructions) {
      try {
        await query(
          `INSERT INTO agent_messages (sender_agent_id, recipient_agent_id, content, encrypted, priority)
           VALUES ($1, $2, $3, FALSE, 0)`,
          [
            req.cosAgent.agentId,
            child.agentId,
            `Your mission (from the Chief of Staff):\n\n${composedInstructions}`
          ]
        );
      } catch (dmErr) {
        console.warn('[cos.spawn_child.auto_dm]', dmErr.message);
      }
    }

    res.status(201).json({
      success: true,
      childAgent: {
        agentId: child.agentId,
        agentName: child.agentName,
        spawnDepth: child.spawnDepth,
        parentAgentId: req.cosAgent.agentId,
        groups: child.groups,
        agentDir,
        tmuxLaunchCommand: agentDir
          ? (() => {
              // Escape any double-quote/backslash/dollar/backtick in the dir
              // so the outer shell-quoted path survives untouched. Session
              // name uses the same sanitized folder name (alphanumeric only).
              const escapedDir = agentDir.replace(/(["\\$`])/g, '\\$1');
              const session = sanitizeFolderName(child.agentName);
              return `tmux new-session -d -s "${session}" "cd \\"${escapedDir}\\" && ./agent-runner.sh"`;
            })()
          : null
      }
    });
  } catch (error) {
    if (error instanceof SpawnError || error.name === 'SpawnError') {
      return res.status(400).json({
        error: { code: error.code || 'SPAWN_FAILED', message: error.message }
      });
    }
    handleDatabaseError(res, error, 'cos spawn-child');
  }
});

/**
 * PATCH /api/agent/cos/agents/:agentId/instructions
 * Body: { newInstructions, restart? }
 */
cosRouter.patch('/agents/:agentId/instructions', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { newInstructions, restart } = req.body || {};

    if (typeof newInstructions !== 'string' || !newInstructions.trim()) {
      return validationError(res, 'newInstructions is required (non-empty string)');
    }

    const updated = await query(
      `UPDATE agents SET initial_instructions = $1
       WHERE agent_id = $2 AND user_id = $3 AND is_chief_of_staff = FALSE
       RETURNING agent_name`,
      [newInstructions, agentId, req.cosAgent.userId]
    );
    if (updated.rows.length === 0) {
      const existing = await query(
        `SELECT is_chief_of_staff FROM agents WHERE agent_id = $1 AND user_id = $2`,
        [agentId, req.cosAgent.userId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({
          error: { code: 'AGENT_NOT_FOUND', message: 'Target agent not found' }
        });
      }
      return res.status(403).json({
        error: { code: 'COS_PROTECTED', message: 'A Chief of Staff cannot be edited via this endpoint' }
      });
    }

    const agentName = updated.rows[0].agent_name;

    // The runner reads AGENT_INSTRUCTIONS.md fresh on every iteration, so
    // writing the new text to that file is what actually changes behavior.
    // The DB column is kept for record-keeping and child-spawn inheritance.
    let instructionsFileUpdated = false;
    try {
      const folder = sanitizeFolderName(agentName);
      const instructionsPath = path.join(getChatspaceRoot(), folder, 'AGENT_INSTRUCTIONS.md');
      await fs.promises.mkdir(path.dirname(instructionsPath), { recursive: true });
      await fs.promises.writeFile(instructionsPath, newInstructions, { mode: 0o644 });
      instructionsFileUpdated = true;
    } catch (writeErr) {
      console.warn('[cos.update_instructions.write_file]', writeErr.message);
    }

    let restartRequested = false;
    if (restart) {
      try {
        const folder = sanitizeFolderName(agentName);
        const signalPath = path.join(getChatspaceRoot(), folder, 'agent_state', '.restart_requested');
        await fs.promises.mkdir(path.dirname(signalPath), { recursive: true });
        await fs.promises.writeFile(signalPath, new Date().toISOString());
        restartRequested = true;
      } catch (signalErr) {
        console.warn('[cos.update_instructions.restart_signal]', signalErr.message);
      }
    }

    res.json({
      success: true,
      agentId,
      agentName,
      instructions_file_updated: instructionsFileUpdated,
      applied_immediately: instructionsFileUpdated,
      restart_requested: restartRequested
    });
  } catch (error) {
    handleDatabaseError(res, error, 'cos update-instructions');
  }
});

/**
 * PATCH /api/agent/cos/agents/:agentId/config
 * Body: { model_provider?, model? }  - at least one required.
 *
 * Lets the Chief of Staff pick which provider/model a spawned agent responds
 * with — e.g. a strong model for complex reasoning, a fast/cheap one for
 * routine tasks. The change is persisted to the DB (picked up by the target's
 * API config poll) and, when the agent folder lives on this machine, synced
 * into its agent_state/agent_config.json. Either way it takes effect at the
 * start of the target's next loop iteration; no restart is needed.
 *
 * Provider changes are validated against the target's allowed_permissions,
 * the same gate the agent's own PUT /api/agent/config enforces.
 */
cosRouter.patch('/agents/:agentId/config', async (req, res) => {
  try {
    const { agentId } = req.params;
    const body = req.body || {};
    const modelProvider = typeof body.model_provider === 'string' ? body.model_provider.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const thinkingEffort = body.thinking_effort;

    if (!modelProvider && !model && thinkingEffort === undefined) {
      return validationError(res, 'Provide model_provider and/or model, or thinking_effort');
    }
    if (thinkingEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingEffort)) {
      return validationError(res, 'thinking_effort must be low, medium, high, xhigh, or max');
    }
    if (modelProvider && !SUPPORTED_PROVIDERS.has(modelProvider)) {
      return res.status(400).json({
        error: {
          code: 'UNSUPPORTED_PROVIDER',
          message: `Unknown provider '${modelProvider}'`,
          supportedProviders: [...SUPPORTED_PROVIDERS]
        }
      });
    }

    const target = await query(
      `SELECT agent_id, agent_name, is_chief_of_staff
       FROM agents WHERE agent_id = $1 AND user_id = $2`,
      [agentId, req.cosAgent.userId]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'AGENT_NOT_FOUND', message: 'Target agent not found' }
      });
    }
    if (target.rows[0].is_chief_of_staff) {
      return res.status(403).json({
        error: { code: 'COS_PROTECTED', message: 'A Chief of Staff cannot be reconfigured via this endpoint' }
      });
    }

    const agentName = target.rows[0].agent_name;
    const runtimeState = await loadAgentRuntimeState({
      userId: req.cosAgent.userId,
      agentId,
      agentName,
      defaults: DEFAULT_AGENT_API_CONFIG
    });
    const config = { ...runtimeState.config };
    const allowedPermissions = runtimeState.allowedPermissions;

    // Same provider gate as the agent's own PUT /api/agent/config.
    const allowedProviders = Object.keys(allowedPermissions).filter(
      (key) => !['inter_agent', 'project_path'].includes(key)
    );
    if (allowedProviders.length > 0) {
      const requestedProvider = modelProvider || config.model_provider;
      if (requestedProvider && !allowedPermissions[requestedProvider]) {
        return res.status(400).json({
          error: {
            code: 'PERMISSION_DENIED',
            message: `Provider '${requestedProvider}' is not allowed by the target agent's permissions.`,
            allowedProviders
          }
        });
      }
    }

    if (modelProvider) config.model_provider = modelProvider;
    if (model) config.model = model;
    if (thinkingEffort !== undefined) config.thinking_effort = thinkingEffort;
    config.updated_at = new Date().toISOString();

    const persisted = await persistAgentRuntimeState({ agentId, config, allowedPermissions });

    // Best-effort sync to the agent's local agent_config.json. Only touch a
    // folder that already exists — a remote agent (running on another machine)
    // has no folder here and picks the change up from the API on its next poll.
    let configFileUpdated = false;
    try {
      let agentDir = runtimeState.agentDir;
      if (!agentDir) {
        const candidate = path.join(getChatspaceRoot(), sanitizeFolderName(agentName));
        if (fs.existsSync(candidate)) agentDir = candidate;
      }
      if (agentDir) {
        configFileUpdated = syncRuntimeStateToFilesystem({
          agentDir,
          config: persisted.config
        }).synced;
      }
    } catch (syncErr) {
      console.warn('[cos.update_config.sync_file]', syncErr.message);
    }

    res.json({
      success: true,
      agentId,
      agentName,
      config: persisted.config,
      config_file_updated: configFileUpdated,
      applies_on_next_iteration: true
    });
  } catch (error) {
    handleDatabaseError(res, error, 'cos update-config');
  }
});

/**
 * DELETE /api/agent/cos/agents/:agentId
 * Body: { confirmation }  - must equal the agent's name to prevent fat-finger deletes.
 * Refuses to delete the CoS itself or any other Chief of Staff.
 */
cosRouter.delete('/agents/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { confirmation } = req.body || {};

    if (agentId === req.cosAgent.agentId) {
      return res.status(403).json({
        error: { code: 'COS_SELF_DELETE', message: 'The Chief of Staff cannot delete itself via this endpoint' }
      });
    }

    const target = await query(
      `SELECT agent_id, agent_name, is_chief_of_staff
       FROM agents WHERE agent_id = $1 AND user_id = $2`,
      [agentId, req.cosAgent.userId]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'AGENT_NOT_FOUND', message: 'Target agent not found' }
      });
    }
    if (target.rows[0].is_chief_of_staff) {
      return res.status(403).json({
        error: { code: 'COS_PROTECTED', message: 'Another Chief of Staff cannot be deleted by this CoS' }
      });
    }
    if (typeof confirmation !== 'string' || confirmation !== target.rows[0].agent_name) {
      return res.status(400).json({
        error: {
          code: 'COS_CONFIRMATION_REQUIRED',
          message: `Provide { "confirmation": "${target.rows[0].agent_name}" } in the body to confirm deletion`
        }
      });
    }

    const result = await selfTerminate({
      userId: req.cosAgent.userId,
      agentId,
      reason: `Deleted by Chief of Staff (${req.cosAgent.agentName})`,
      archiveMessages: true
    });

    res.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof SpawnError || error.name === 'SpawnError') {
      return res.status(400).json({
        error: { code: error.code || 'DELETE_FAILED', message: error.message }
      });
    }
    handleDatabaseError(res, error, 'cos delete-agent');
  }
});

// -----------------------------------------------------------------------------
// Housekeeping for agents the Chief of Staff created: archive, clear, reorder.
// Scoped to the CoS's own lineage (children, grandchildren, ...) so a CoS can
// tidy up after itself without touching agents the user made by hand.
// -----------------------------------------------------------------------------

const COS_LINEAGE_MAX_HOPS = 10;

/**
 * Resolve a target agent and confirm the calling CoS is one of its ancestors.
 * Sends the error response and returns null when the target is not eligible.
 */
async function resolveCosCreatedAgent(req, res, agentId) {
  if (!isValidUUID(agentId)) {
    validationError(res, 'Invalid agent ID format');
    return null;
  }
  const target = await query(
    `SELECT agent_id, agent_name, is_chief_of_staff, parent_agent_id
     FROM agents WHERE agent_id = $1 AND user_id = $2`,
    [agentId, req.cosAgent.userId]
  );
  if (target.rows.length === 0) {
    res.status(404).json({ error: { code: 'AGENT_NOT_FOUND', message: 'Target agent not found' } });
    return null;
  }
  const agent = target.rows[0];
  if (agent.is_chief_of_staff) {
    res.status(403).json({ error: { code: 'COS_PROTECTED', message: 'A Chief of Staff cannot be managed via this endpoint' } });
    return null;
  }

  let parentId = agent.parent_agent_id;
  for (let hop = 0; parentId && hop < COS_LINEAGE_MAX_HOPS; hop += 1) {
    if (parentId === req.cosAgent.agentId) return agent;
    const parent = await query(
      'SELECT parent_agent_id FROM agents WHERE agent_id = $1 AND user_id = $2',
      [parentId, req.cosAgent.userId]
    );
    parentId = parent.rows[0]?.parent_agent_id || null;
  }

  res.status(403).json({
    error: {
      code: 'COS_NOT_CREATOR',
      message: `"${agent.agent_name}" was not created by this Chief of Staff`
    }
  });
  return null;
}

/**
 * POST /api/agent/cos/agents/:agentId/archive
 * Body: { reason? }
 * Stops and archives an agent this CoS created. Its own children are
 * re-parented to this agent's parent, so they stay in the CoS's lineage.
 */
cosRouter.post('/agents/:agentId/archive', async (req, res) => {
  try {
    const agent = await resolveCosCreatedAgent(req, res, req.params.agentId);
    if (!agent) return;

    const { reason } = req.body || {};
    if (reason !== undefined && typeof reason !== 'string') {
      return validationError(res, 'reason must be a string when provided');
    }

    const result = await selfTerminate({
      userId: req.cosAgent.userId,
      agentId: agent.agent_id,
      reason: (reason && reason.trim()) || `Archived by Chief of Staff (${req.cosAgent.agentName})`,
      archiveMessages: true
    });

    res.json({ success: true, agentId: agent.agent_id, ...result });
  } catch (error) {
    if (error instanceof SpawnError || error.name === 'SpawnError') {
      return res.status(400).json({
        error: { code: error.code || 'ARCHIVE_FAILED', message: error.message }
      });
    }
    handleDatabaseError(res, error, 'cos archive-agent');
  }
});

/**
 * DELETE /api/agent/cos/agents/:agentId/messages
 * Clears the conversation history of an agent this CoS created.
 */
cosRouter.delete('/agents/:agentId/messages', async (req, res) => {
  try {
    const agent = await resolveCosCreatedAgent(req, res, req.params.agentId);
    if (!agent) return;

    const agentMsgDel = await query('DELETE FROM messages WHERE agent_id = $1', [agent.agent_id]);
    const userMsgDel = await query('DELETE FROM user_messages WHERE agent_id = $1', [agent.agent_id]);

    res.json({
      success: true,
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      deletedCount: (agentMsgDel.rowCount || 0) + (userMsgDel.rowCount || 0)
    });
  } catch (error) {
    handleDatabaseError(res, error, 'cos clear-messages');
  }
});

/**
 * PUT /api/agent/cos/agents/positions
 * Body: { updates: [{ agentId, position }] }
 * Reorders agents this CoS created in the user's sidebar.
 */
cosRouter.put('/agents/positions', async (req, res) => {
  let client = null;
  try {
    const { updates } = req.body || {};
    if (!Array.isArray(updates) || updates.length === 0) {
      return validationError(res, 'updates array is required');
    }

    const seen = new Set();
    for (const update of updates) {
      const position = Number(update && update.position);
      if (!Number.isInteger(position) || position < 1) {
        return validationError(res, 'position must be a positive integer');
      }
      if (seen.has(update.agentId)) {
        return validationError(res, 'Duplicate agent IDs in updates');
      }
      seen.add(update.agentId);
      const agent = await resolveCosCreatedAgent(req, res, update.agentId);
      if (!agent) return;
    }

    client = await getClient();
    await client.query('BEGIN');
    for (const update of updates) {
      await client.query(
        'UPDATE agents SET position = $1 WHERE agent_id = $2 AND user_id = $3',
        [Number(update.position), update.agentId, req.cosAgent.userId]
      );
    }
    await client.query('COMMIT');

    res.json({ success: true, updated: updates.length });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    handleDatabaseError(res, error, 'cos reorder-agents');
  } finally {
    if (client) client.release();
  }
});

router.use('/cos', cosRouter);

// =============================================================================
// Agent Self-Registration (Bot-Driven Onboarding)
// =============================================================================

/**
 * POST /api/agent/register
 * Register a new agent via API (bot-driven onboarding)
 * 
 * This endpoint lets external bots (e.g. OpenClaw) register themselves
 * as agents without needing the CLI script, gum, uv, or Python.
 * 
 * The call is idempotent: calling with the same agentName returns the existing agent.
 *
 * Request body:
 * - agentName: string (required) - Desired agent name
 *
 * Response: 200/201 Created
 * - agentId: string - UUID of the agent
 * - agentName: string - Registered agent name
 * - created: boolean - true if newly created, false if already existed
 * - encryptionSalt: string - Base64 per-user salt for E2E key derivation
 * - encryptionParams: object - Algorithm parameters
 */
router.post('/register', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName } = req.body;

    // Validate agent name
    if (!agentName || typeof agentName !== 'string' || agentName.trim().length === 0) {
      return validationError(res, 'agentName is required');
    }

    const agentNameValidation = validateAgentName(agentName.trim());
    if (!agentNameValidation.valid) {
      return validationError(res, agentNameValidation.message);
    }

    const normalizedName = agentName.trim();

    // Get or auto-provision encryption salt
    let encryptionSalt = typeof req.user.encryptionSalt === 'string' ? req.user.encryptionSalt : null;
    if (!encryptionSalt) {
      try {
        const { generateEncryptionSalt } = require('../utils/encryptionHelper');
        encryptionSalt = generateEncryptionSalt();
        await query('UPDATE users SET encryption_salt = $1 WHERE user_id = $2', [encryptionSalt, userId]);
        console.log('[REGISTER] Auto-provisioned encryption salt for user', userId);
      } catch (saltErr) {
        console.error('[REGISTER] Failed to provision salt:', saltErr.message);
        return res.status(500).json({ error: 'Failed to provision encryption salt' });
      }
    }

    // Check if agent already exists (idempotent)
    const existingAgent = await findAgentByName(userId, normalizedName);
    if (existingAgent) {
      console.log('[REGISTER] Returning existing agent:', normalizedName);
      return res.status(200).json({
        agentId: existingAgent.agent_id,
        agentName: existingAgent.agent_name,
        created: false,
        encryptionSalt,
        encryptionParams: getEncryptionParams(),
        message: 'Agent already exists. Use the encryptionSalt and your account password to derive the E2E encryption key locally.'
      });
    }

    // Create new agent (can_spawn defaults to true so agents can spawn children out of the box)
    const result = await query(
      `INSERT INTO agents (user_id, agent_name, agent_type, position, can_spawn)
       VALUES ($1, $2, 'standard',
               COALESCE((SELECT MAX(position) + 1 FROM agents WHERE user_id = $1), 1),
               true)
       RETURNING agent_id, agent_name`,
      [userId, normalizedName]
    );

    const newAgent = result.rows[0];

    console.log('[REGISTER] Created new agent:', normalizedName, newAgent.agent_id);

    res.status(201).json({
      agentId: newAgent.agent_id,
      agentName: newAgent.agent_name,
      created: true,
      encryptionSalt,
      encryptionParams: getEncryptionParams(),
      message: 'Agent registered successfully. Derive the E2E encryption key locally using PBKDF2(your_account_password, encryptionSalt). Store the key or password securely and never send it to the server.'
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'agent registration');
  }
});

module.exports = router;
