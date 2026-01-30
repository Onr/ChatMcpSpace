/**
 * User API Routes
 * AJAX endpoints for frontend polling and user interactions
 */

const express = require('express');
const fs = require('fs');
const fsPromises = require('fs').promises;
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
const router = express.Router();
const { attachUserFromSession } = require('../middleware/authMiddleware');
const { userPollingRateLimiter, feedbackRateLimiter } = require('../middleware/rateLimitMiddleware');
const { query, getClient } = require('../db/connection');
const { validateTimestamp, isValidUUID, formatTimestampForDatabase, validateMessageContent, validateAttachmentIds } = require('../utils/validation');
const { validationError, forbiddenError, handleDatabaseError, internalError } = require('../utils/errorHandler');
const { logUnauthorizedAccess } = require('../utils/securityLogger');
const ttsService = require('../services/ttsService');
const { uploadAttachment, downloadAttachment } = require('../controllers/userAttachmentController');
const archiveService = require('../services/archiveService');
const { createArchiveAwareQuery } = require('../utils/archiveQueryWrapper');

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
 *   - lastActivityTime: string|null - ISO 8601 timestamp of last activity (message or agent heartbeat)
 *   - unreadCount: number - Count of unanswered questions
 *   - highestPriority: 'low' | 'normal' | 'high' - Highest priority of recent messages
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
          agents.position,
          agents.last_seen_at,
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
        LEFT JOIN archived_agents aa ON agents.agent_id = aa.agent_id
        WHERE agents.user_id = $1 AND aa.archived_agent_id IS NULL
        GROUP BY
          agents.agent_id,
          agents.agent_name,
          agents.agent_type,
          agents.position,
          agents.last_seen_at,
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
          agents.position,
          agents.last_seen_at,
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
      const lastMessageTime = row.last_message_time;
      const lastMessageId = row.last_message_id;

      return {
        agentId: row.agent_id,
        name: row.agent_name,
        agentType: row.agent_type || 'standard',
        position: row.position,
        lastMessageId: lastMessageId || null,
        lastMessageTime: lastMessageTime ? lastMessageTime.toISOString() : null,
        lastActivityTime: lastActivityTime ? lastActivityTime.toISOString() : null,
        unreadCount: parseInt(row.unread_count) || 0,
        highestPriority: row.priority_value === 3 ? 'high' : row.priority_value === 2 ? 'normal' : 'low',
        lastMessagePriority: row.last_message_priority === 2 ? 'high' : row.last_message_priority === 1 ? 'normal' : 'low',
        newAgentAudioUrl: newAgentAudioUrl
      };
    }));

    res.status(200).json({
      agents: agents
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
      const agentId = update?.agentId;
      const position = Number(update?.position);

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
router.get('/messages/:agentId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentId } = req.params;
    const { since, cursor } = req.query;

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

    // Create archive-aware query with fallback
    const messagesQueryFn = createArchiveAwareQuery(
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
          m.hidden_from_agent,
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
          m.hidden_from_agent,
          m.created_at,
          (EXTRACT(EPOCH FROM m.created_at) * 1000000)::BIGINT as created_at_micro
        FROM messages m
        WHERE m.agent_id = $1${buildTimeFilter('m')}
        ORDER BY m.created_at ASC
      `,
      'get_messages'
    );

    const messagesResult = await messagesQueryFn(messageParams);

    // Mark all fetched messages as read.
    // Prefer bulk updates, but fall back to per-row updates for test DBs (pg-mem)
    // that don't fully support `ANY($1)` array binding semantics.
    if (messagesResult.rows.length > 0) {
      const messageIds = messagesResult.rows.map(row => row.message_id);
      const updated = await query(
        `UPDATE messages SET read_at = NOW() WHERE message_id = ANY($1) AND read_at IS NULL`,
        [messageIds]
      );

      if ((updated?.rowCount || 0) !== messageIds.length) {
        for (const messageId of messageIds) {
          await query('UPDATE messages SET read_at = NOW() WHERE message_id = $1 AND read_at IS NULL', [messageId]);
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

    // Create archive-aware query with fallback
    const userMessagesQueryFn = createArchiveAwareQuery(
      // Primary query with archive filtering
      () => `
        SELECT
          um.user_message_id,
          um.content,
          um.created_at,
          um.read_at,
          um.hidden_from_agent,
          (EXTRACT(EPOCH FROM um.created_at) * 1000000)::BIGINT as created_at_micro
        FROM user_messages um
        LEFT JOIN archived_messages am ON um.user_message_id = am.user_message_id
        WHERE um.agent_id = $1 AND am.archived_message_id IS NULL${buildTimeFilter('um')}
        ORDER BY um.created_at ASC
      `,
      // Fallback query without archive filtering
      () => `
        SELECT
          um.user_message_id,
          um.content,
          um.created_at,
          um.read_at,
          um.hidden_from_agent,
          (EXTRACT(EPOCH FROM um.created_at) * 1000000)::BIGINT as created_at_micro
        FROM user_messages um
        WHERE um.agent_id = $1${buildTimeFilter('um')}
        ORDER BY um.created_at ASC
      `,
      'get_user_messages'
    );

    const userMessagesResult = await userMessagesQueryFn(userMessageParams);

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
    const userMessages = userMessagesResult.rows.map(row => ({
      messageId: row.user_message_id,
      type: 'user_message',
      content: row.content,
      priority: 0,
      urgent: false,
      timestamp: row.created_at.toISOString(),
      cursor: row.created_at_micro,
      readAt: row.read_at ? row.read_at.toISOString() : null,
      hiddenFromAgent: row.hidden_from_agent || false,
      attachments: userAttachmentsMap[row.user_message_id] || []
    }));

    const combinedMessages = [...messages, ...userMessages].sort((a, b) => {
      return new Date(a.timestamp) - new Date(b.timestamp);
    });

    res.status(200).json({
      messages: combinedMessages
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching messages');
  }
});

/**
 * GET /api/user/messages/:agentId/status/:messageId
 * Get read status for a specific user message
 * 
 * Response: 200 OK
 * - messageId: string - UUID of the message
 * - readAt: string|null - ISO 8601 timestamp when agent read the message, or null
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

    // Get the read status
    const result = await query(
      'SELECT read_at FROM user_messages WHERE user_message_id = $1 AND agent_id = $2',
      [messageId, agentId]
    );

    if (result.rows.length === 0) {
      return validationError(res, 'Message not found');
    }

    res.status(200).json({
      messageId: messageId,
      readAt: result.rows[0].read_at ? result.rows[0].read_at.toISOString() : null
    });

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
    const { agentId, content, encrypted, attachmentIds } = req.body;
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
      'SELECT agent_id FROM agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      logUnauthorizedAccess(req, 'agent', agentId, 'User does not own this agent');
      return forbiddenError(res, 'You do not have access to this agent');
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

    // Insert user message
    // Content can be null if only attachments are provided
    const finalContent = hasContent ? content.trim() : null;
    const insertResult = await client.query(
      `INSERT INTO user_messages (agent_id, content, encrypted)
       VALUES ($1, $2, $3)
       RETURNING user_message_id, created_at`,
      [agentId, finalContent, isEncrypted]
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

    res.status(201).json({
      messageId: userMessageId,
      timestamp: insertResult.rows[0].created_at.toISOString(),
      attachmentCount: validatedAttachmentIds.length
    });

  } catch (error) {
    // Rollback transaction on error
    await client.query('ROLLBACK');
    return handleDatabaseError(res, error, 'creating user message');
  } finally {
    // Release client back to pool
    client.release();
  }
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
router.post('/feedback', feedbackRateLimiter, async (req, res) => {
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
    // PRIVACY: user_agent intentionally not collected to ensure true anonymity
    // (user_agent + page_url + timestamp enables browser fingerprinting)

    // Insert into PostgreSQL (no user_id for anonymity)
    const result = await query(
      `INSERT INTO feedback (message, kind, page_url)
       VALUES ($1, $2, $3)
       RETURNING feedback_id, created_at`,
      [trimmedMessage, kind, trimmedPageUrl]
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

module.exports = router;
