/**
 * Agent API Routes
 * RESTful API endpoints for AI agents to send messages and poll for responses
 */

const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../middleware/authMiddleware');
const { agentApiRateLimiter, agentPollingRateLimiter } = require('../middleware/rateLimitMiddleware');
const { query, getClient } = require('../db/connection');
const {
  validateMessageContent,
  validateAttachmentIds,
  validatePriority,
  validateOptionsArray,
  validateAgentName,
  validateBoolean,
  validateTimestamp,
  formatTimestampForDatabase,
  validateFreeResponseHint
} = require('../utils/validation');
const { validationError, handleDatabaseError, internalError } = require('../utils/errorHandler');
const { uploadAttachment, downloadAttachment } = require('../controllers/agentAttachmentController');
const { generateMainCLIScript } = require('../utils/apiGuideGenerator');

// Apply API key authentication to all agent routes
router.use(requireApiKey);

// Apply rate limiting to all agent API routes
router.use(agentApiRateLimiter);

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
router.post('/messages', async (req, res) => {
  const client = await getClient();

  try {
    const { content, priority, agentName, encrypted, agentType, attachmentIds } = req.body;
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

    // Validate priority value (0=ok, 1=attention, 2=urgent)
    const priorityValidation = validatePriority(priority);
    if (!priorityValidation.valid) {
      return validationError(res, priorityValidation.message);
    }
    const messagePriority = priorityValidation.value;
    const isUrgent = priorityValidation.isUrgent;

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
        `INSERT INTO agents (user_id, agent_name, agent_type, position)
         VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM agents WHERE user_id = $1), 1))
         RETURNING agent_id, position`,
        [userId, agentName, resolvedAgentType]
      );
      agentId = newAgentResult.rows[0].agent_id;
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

    // Update last_seen_at for this agent (tracks when agent was last active)
    await client.query('UPDATE agents SET last_seen_at = NOW() WHERE agent_id = $1', [agentId]);

    // Insert message into database with encryption flag
    // Content can be null if only attachments are provided
    const finalContent = hasContent ? content : null;
    const messageResult = await client.query(
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

    // Fetch any unread user messages for this agent (outside transaction)
    const unreadResult = await query(
      `SELECT user_message_id, content, encrypted, created_at
       FROM user_messages
       WHERE agent_id = $1 AND read_at IS NULL
       ORDER BY created_at ASC`,
      [agentId]
    );

    // Mark fetched messages as read.
    // Prefer bulk updates, but fall back to per-row updates for test DBs (pg-mem)
    // that don't fully support `ANY($1)` array binding semantics.
    if (unreadResult.rows.length > 0) {
      const msgIds = unreadResult.rows.map(r => r.user_message_id);
      const updated = await query(
        `UPDATE user_messages SET read_at = NOW() WHERE user_message_id = ANY($1)`,
        [msgIds]
      );

      if ((updated?.rowCount || 0) !== msgIds.length) {
        for (const msgId of msgIds) {
          await query('UPDATE user_messages SET read_at = NOW() WHERE user_message_id = $1', [msgId]);
        }
      }
    }

    const newMessages = unreadResult.rows.map(r => ({
      messageId: r.user_message_id,
      content: r.content,
      encrypted: r.encrypted || false,
      timestamp: r.created_at.toISOString()
    }));

    // Return success response with messageId and any new messages
    res.status(201).json({
      status: 'sent',
      messageId: messageId,
      attachmentCount: validatedAttachmentIds.length,
      newMessages: newMessages
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
router.post('/questions', async (req, res) => {
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
        `INSERT INTO agents (user_id, agent_name, agent_type, position)
         VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM agents WHERE user_id = $1), 1))
         RETURNING agent_id, position`,
        [userId, agentName, 'standard']
      );
      agentId = newAgentResult.rows[0].agent_id;
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
    await client.query('UPDATE agents SET last_seen_at = NOW() WHERE agent_id = $1', [agentId]);

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
    const userId = req.user.userId;
    const { since, agentName } = req.query;

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
        return res.status(200).json({ responses: [] });
      }
      agentId = agent.agent_id;

      // Update last_seen_at for this agent (tracks when agent was last active)
      await query('UPDATE agents SET last_seen_at = NOW() WHERE agent_id = $1', [agentId]);
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
    let textWhereConditions = [
      'a.user_id = $1',
      'um.user_message_id IN (SELECT user_message_id FROM user_messages WHERE read_at IS NULL)'
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
        a.agent_id,
        a.agent_name
      FROM user_messages um
      JOIN agents a ON um.agent_id = a.agent_id
      WHERE ${textWhereConditions.join(' AND ')}
      ORDER BY um.created_at ASC
    `;

    const optionResult = await query(queryText, queryParams);
    const textResult = await query(textQuery, textQueryParams);

    // Mark option responses (user_responses) as read by agent
    if (optionResult.rows.length > 0) {
      const responseIds = optionResult.rows.map(row => row.response_id);
      const updated = await query(
        `UPDATE user_responses SET read_at = NOW() WHERE response_id = ANY($1) AND read_at IS NULL`,
        [responseIds]
      );

      if ((updated?.rowCount || 0) !== responseIds.length) {
        for (const responseId of responseIds) {
          await query(
            'UPDATE user_responses SET read_at = NOW() WHERE response_id = $1 AND read_at IS NULL',
            [responseId]
          );
        }
      }
    }

    // Mark text responses as read by agent
    if (textResult.rows.length > 0) {
      const userMessageIds = textResult.rows.map(row => row.user_message_id);
      const updated = await query(
        `UPDATE user_messages SET read_at = NOW() WHERE user_message_id = ANY($1) AND read_at IS NULL`,
        [userMessageIds]
      );

      if ((updated?.rowCount || 0) !== userMessageIds.length) {
        for (const messageId of userMessageIds) {
          await query(
            'UPDATE user_messages SET read_at = NOW() WHERE user_message_id = $1 AND read_at IS NULL',
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
        WHERE uma.user_message_id = ANY($1)
        ORDER BY uma.user_message_id, uma.attachment_order ASC
      `, [userMessageIdsForAttachments]);

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
      responseType: row.free_response && !row.selected_option ? 'open' : (row.free_response && row.selected_option ? 'option+open' : 'option'),
      from: 'user',  // Currently all responses come from the user; future: could be another agent's name
      agentId: row.agent_id,
      agentName: row.agent_name,
      questionId: row.question_id,
      selectedOption: row.selected_option,
      freeResponse: row.free_response,
      timestamp: row.timestamp.toISOString()
    }));

    const textResponses = textResult.rows.map(row => ({
      responseType: 'text',
      from: 'user',  // Currently all responses come from the user; future: could be another agent's name
      agentId: row.agent_id,
      agentName: row.agent_name,
      messageId: row.user_message_id,
      content: row.content,
      encrypted: row.encrypted || false,
      timestamp: row.created_at.toISOString(),
      attachments: userAttachmentsMap[row.user_message_id] || []
    }));

    const combinedResponses = [...optionResponses, ...textResponses].sort((a, b) => {
      return new Date(a.timestamp) - new Date(b.timestamp);
    });

    // Return ALL responses for this agent (not just the latest)
    // The agent needs to see all new messages since their last check
    res.status(200).json({
      responses: combinedResponses
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching responses');
  }
});

/**
 * Helper to look up an agent by name for the authenticated user
 */
async function findAgentByName(userId, agentName) {
  const normalizedAgentName = agentName.trim();
  const agentResult = await query(
    'SELECT agent_id, agent_name, agent_type FROM agents WHERE user_id = $1 AND agent_name = $2',
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

    // Fetch agent messages (messages and questions)
    const messagesResult = await query(
      `SELECT 
        message_id,
        message_type,
        content,
        priority,
        urgent,
        allow_free_response,
        free_response_hint,
        created_at
      FROM messages
      WHERE agent_id = $1
      ORDER BY created_at ASC`,
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

    // Fetch user messages (free-text messages from the user)
    const userMessagesResult = await query(
      `SELECT 
        user_message_id,
        content,
        created_at
      FROM user_messages
      WHERE agent_id = $1
      ORDER BY created_at ASC`,
      [agent.agent_id]
    );

    // Build combined message list
    const allMessages = [];

    // Add agent messages
    for (const row of messagesResult.rows) {
      allMessages.push({
        messageId: row.message_id,
        type: row.message_type === 'question' ? 'agent_question' : 'agent_message',
        from: agentName,
        content: row.content,
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

    // Add user messages (free-text messages)
    for (const row of userMessagesResult.rows) {
      allMessages.push({
        messageId: row.user_message_id,
        type: 'user_message',
        from: 'user',
        content: row.content,
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
        message_id,
        message_type,
        content,
        priority,
        urgent,
        allow_free_response,
        free_response_hint,
        created_at
      FROM messages
      WHERE agent_id = $1
      ORDER BY created_at DESC
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
 * Searches in cwd/chatspace, $HOME/chatspace, and tmp subdirectories
 * @param {string} agentFolder - The sanitized agent folder name
 * @returns {string|null} Path to agent directory or null if not found
 */
function findAgentChatspaceDir(agentFolder) {
  const fs = require('fs');
  const path = require('path');

  const searchPaths = [
    path.join(process.cwd(), 'chatspace', agentFolder),
    path.join(process.env.HOME || '', 'chatspace', agentFolder),
  ];

  // Also check tmp subdirectories (for development/testing)
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (fs.existsSync(tmpDir)) {
    try {
      const tmpSubdirs = fs.readdirSync(tmpDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(tmpDir, d.name, 'chatspace', agentFolder));
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

    // Build path to agent's config files
    const agentFolder = agentName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const fs = require('fs');
    const path = require('path');

    // Default config
    let config = {
      model_provider: 'codex',
      model: 'gpt-5.1-codex-max',
      approval_mode: 'full-auto',
      sandbox_mode: 'none'
    };

    // Default allowed permissions (all allowed)
    let allowedPermissions = {};

    // Find agent's chatspace directory (searches multiple locations)
    const agentDir = findAgentChatspaceDir(agentFolder);

    if (agentDir) {
      const configPath = path.join(agentDir, 'agent_state', 'agent_config.json');
      const allowedPath = path.join(agentDir, 'agent_state', 'allowed_permissions.json');

      if (fs.existsSync(configPath)) {
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
          // Use defaults
        }
      }

      if (fs.existsSync(allowedPath)) {
        try {
          allowedPermissions = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
        } catch (e) {
          // Use defaults
        }
      }
    }

    res.status(200).json({
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      config,
      allowedPermissions
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'fetching agent config');
  }
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
    const { agentName, model_provider, model, approval_mode, sandbox_mode } = req.body;
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

    const agentFolder = agentName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const fs = require('fs');
    const path = require('path');

    // Find agent directory (searches multiple locations)
    const agentDir = findAgentChatspaceDir(agentFolder);

    if (!agentDir) {
      return res.status(404).json({
        error: {
          code: 'AGENT_DIR_NOT_FOUND',
          message: 'Agent directory not found on filesystem'
        }
      });
    }

    const configPath = path.join(agentDir, 'agent_state', 'agent_config.json');
    const allowedPath = path.join(agentDir, 'agent_state', 'allowed_permissions.json');

    // Load allowed permissions for validation
    let allowedPermissions = {};
    if (fs.existsSync(allowedPath)) {
      try {
        allowedPermissions = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
      } catch (e) {
        // Continue without permission validation
      }
    }

    // Validate against allowed permissions if they exist
    const hasPermissionRestrictions = Object.keys(allowedPermissions).length > 0;
    if (hasPermissionRestrictions) {
      const requestedProvider = model_provider;

      // Validate provider is allowed
      if (requestedProvider && !allowedPermissions[requestedProvider]) {
        return res.status(400).json({
          error: {
            code: 'PERMISSION_DENIED',
            message: `Provider '${requestedProvider}' is not allowed by your CLI permissions.`,
            allowedProviders: Object.keys(allowedPermissions)
          }
        });
      }

      // Validate provider-specific permissions
      const providerPerms = allowedPermissions[requestedProvider] || {};

      if (requestedProvider === 'codex' || requestedProvider === 'default' || requestedProvider === 'ollama' || requestedProvider === 'openrouter') {
        // Validate sandbox mode
        const allowedSandboxes = providerPerms['--sandbox'] || [];
        if (allowedSandboxes.length > 0 && sandbox_mode) {
          const sandboxValue = sandbox_mode === 'none' ? 'danger-full-access' : sandbox_mode;
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
        if (approval_mode === 'full-auto' && sandbox_mode === 'none') {
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
        if (sandbox_mode === 'none') {
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
        if (sandbox_mode === 'none') {
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
      }
    }

    // Read existing config
    let config = {};
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (e) {
        // Start with empty config
      }
    }

    // Update only provided fields (project_path is NOT settable from frontend)
    if (model_provider) config.model_provider = model_provider;
    if (model) config.model = model;
    if (approval_mode) config.approval_mode = approval_mode;
    if (sandbox_mode) config.sandbox_mode = sandbox_mode;
    config.updated_at = new Date().toISOString();

    // Write updated config
    fs.mkdirSync(path.join(agentDir, 'agent_state'), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

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

    const agentFolder = agentName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const fs = require('fs');
    const path = require('path');

    // Find agent directory
    const possiblePaths = [
      path.join(process.cwd(), 'chatspace', agentFolder),
      path.join(process.env.HOME || '', 'chatspace', agentFolder)
    ];

    let agentDir = null;
    for (const dir of possiblePaths) {
      if (fs.existsSync(dir)) {
        agentDir = dir;
        break;
      }
    }

    if (!agentDir) {
      return res.status(404).json({
        error: {
          code: 'AGENT_DIR_NOT_FOUND',
          message: 'Agent directory not found on filesystem'
        }
      });
    }

    // Create stop flag file
    const stopFlagPath = path.join(agentDir, 'agent_state', '.stop_requested');
    fs.mkdirSync(path.join(agentDir, 'agent_state'), { recursive: true });
    fs.writeFileSync(stopFlagPath, new Date().toISOString());

    res.status(200).json({
      agentId: agent.agent_id,
      agentName: agent.agent_name,
      message: 'Stop requested. Agent will halt at next opportunity and send confirmation message.'
    });

  } catch (error) {
    return handleDatabaseError(res, error, 'requesting agent stop');
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
    const { apiKey, encryptionSalt } = req.user;
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const script = generateMainCLIScript(apiKey, baseUrl, encryptionSalt);
    res.type('text/plain').send(script);
  } catch (error) {
    console.error('CLI script generation error:', error);
    res.status(500).json({ error: 'Failed to generate script' });
  }
});

module.exports = router;
