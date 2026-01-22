/**
 * Archive Service
 * Handles archiving and unarchiving of agents and individual messages
 *
 * Features:
 * - Archive entire agents (preserves metadata, deletes from active agents table)
 * - Archive individual messages (agent messages or user messages)
 * - Unarchive agents and messages (restore to active tables)
 * - Query archived content with pagination
 */

const { query, getClient } = require('../db/connection');

/**
 * Archive an entire agent with all its messages
 *
 * Process:
 * 1. Validate agent exists and belongs to user
 * 2. Check if already archived
 * 3. Count total messages (agent messages + user messages)
 * 4. Snapshot agent metadata (name, type)
 * 5. Insert into archived_agents table
 * 6. Delete agent (CASCADE deletes messages and user_messages)
 *
 * @param {string} userId - User ID who owns the agent
 * @param {string} agentId - Agent ID to archive
 * @param {string} reason - Optional reason for archiving
 * @returns {Promise<Object>} { archivedAgentId, messageCount }
 * @throws {Error} If agent not found, not owned by user, or already archived
 */
async function archiveAgent(userId, agentId, reason = null) {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 1. Validate agent exists and belongs to user
    const agentResult = await client.query(
      `SELECT agent_id, agent_name, agent_type
       FROM agents
       WHERE agent_id = $1 AND user_id = $2`,
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      throw new Error('Agent not found or access denied');
    }

    const agent = agentResult.rows[0];

    // 2. Check if already archived
    const archivedCheck = await client.query(
      'SELECT archived_agent_id FROM archived_agents WHERE agent_id = $1',
      [agentId]
    );

    if (archivedCheck.rows.length > 0) {
      throw new Error('Agent is already archived');
    }

    // 3. Count total messages (agent messages + user messages)
    const messageCountResult = await client.query(
      `SELECT
        (SELECT COUNT(*) FROM messages WHERE agent_id = $1) +
        (SELECT COUNT(*) FROM user_messages WHERE agent_id = $1) AS total`,
      [agentId]
    );

    const messageCount = parseInt(messageCountResult.rows[0].total, 10);

    // 4 & 5. Insert into archived_agents table with snapshot
    const archiveResult = await client.query(
      `INSERT INTO archived_agents
       (agent_id, user_id, agent_name, agent_type, total_messages, archive_reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING archived_agent_id, archived_at`,
      [agentId, userId, agent.agent_name, agent.agent_type, messageCount, reason]
    );

    const archivedAgentId = archiveResult.rows[0].archived_agent_id;

    // 6. Delete agent from agents table (CASCADE will delete messages and user_messages)
    await client.query(
      'DELETE FROM agents WHERE agent_id = $1',
      [agentId]
    );

    await client.query('COMMIT');

    console.log(`Agent archived successfully: ${agentId} (${messageCount} messages)`);

    return {
      archivedAgentId,
      messageCount,
      archivedAt: archiveResult.rows[0].archived_at
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error archiving agent:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Unarchive (restore) an archived agent
 *
 * Process:
 * 1. Validate archived agent exists and belongs to user
 * 2. Get agent metadata from archived_agents
 * 3. Re-create agent in agents table
 * 4. Set position to MAX(position) + 1 (append to end)
 * 5. Delete from archived_agents table
 *
 * Note: Messages are NOT restored because they were CASCADE deleted.
 * Only the agent shell is restored.
 *
 * @param {string} userId - User ID who owns the archived agent
 * @param {string} archivedAgentId - Archived agent ID to restore
 * @returns {Promise<Object>} { success: true, agentId }
 * @throws {Error} If archived agent not found or not owned by user
 */
async function unarchiveAgent(userId, archivedAgentId) {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 1 & 2. Validate and get archived agent metadata
    const archivedResult = await client.query(
      `SELECT agent_id, agent_name, agent_type
       FROM archived_agents
       WHERE archived_agent_id = $1 AND user_id = $2`,
      [archivedAgentId, userId]
    );

    if (archivedResult.rows.length === 0) {
      throw new Error('Archived agent not found or access denied');
    }

    const archived = archivedResult.rows[0];

    // 3 & 4. Get current max position for user's agents and calculate new position
    const positionResult = await client.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next_position
       FROM agents
       WHERE user_id = $1`,
      [userId]
    );

    const nextPosition = positionResult.rows[0].next_position;

    // Re-create agent in agents table
    const restoreResult = await client.query(
      `INSERT INTO agents (agent_id, user_id, agent_name, agent_type, position)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING agent_id, created_at`,
      [archived.agent_id, userId, archived.agent_name, archived.agent_type, nextPosition]
    );

    const restoredAgentId = restoreResult.rows[0].agent_id;

    // 5. Delete from archived_agents table
    await client.query(
      'DELETE FROM archived_agents WHERE archived_agent_id = $1',
      [archivedAgentId]
    );

    await client.query('COMMIT');

    console.log(`Agent unarchived successfully: ${restoredAgentId} (position: ${nextPosition})`);

    return {
      success: true,
      agentId: restoredAgentId
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error unarchiving agent:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Archive an individual message (agent message or user message)
 *
 * Process:
 * 1. Validate message exists and belongs to user
 * 2. Validate messageType is 'agent_message' or 'user_message'
 * 3. Check if already archived
 * 4. Get message content and attachment info
 * 5. Insert snapshot into archived_messages table
 * 6. Delete message from appropriate table (messages or user_messages)
 *
 * @param {string} userId - User ID who owns the message
 * @param {string} messageId - Message ID to archive (message_id or user_message_id)
 * @param {string} messageType - Type: 'agent_message' or 'user_message'
 * @param {string} note - Optional note about archiving
 * @returns {Promise<Object>} { archivedMessageId }
 * @throws {Error} If message not found, invalid type, or already archived
 */
async function archiveMessage(userId, messageId, messageType, note = null) {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 2. Validate messageType
    if (!['agent_message', 'user_message'].includes(messageType)) {
      throw new Error('Invalid messageType. Must be "agent_message" or "user_message"');
    }

    // Determine which table to query based on messageType
    let messageQuery;
    let messageIdColumn;
    let messageTable;

    if (messageType === 'agent_message') {
      messageTable = 'messages';
      messageIdColumn = 'message_id';
      messageQuery = `
        SELECT m.message_id, m.agent_id, m.content, m.encrypted,
               EXISTS(
                 SELECT 1 FROM message_attachments
                 WHERE message_id = m.message_id
               ) AS has_attachments
        FROM messages m
        JOIN agents a ON m.agent_id = a.agent_id
        WHERE m.message_id = $1 AND a.user_id = $2
      `;
    } else {
      messageTable = 'user_messages';
      messageIdColumn = 'user_message_id';
      messageQuery = `
        SELECT um.user_message_id, um.agent_id, um.content, um.encrypted,
               EXISTS(
                 SELECT 1 FROM user_message_attachments
                 WHERE user_message_id = um.user_message_id
               ) AS has_attachments
        FROM user_messages um
        JOIN agents a ON um.agent_id = a.agent_id
        WHERE um.user_message_id = $1 AND a.user_id = $2
      `;
    }

    // 1. Validate message exists and belongs to user
    const messageResult = await client.query(messageQuery, [messageId, userId]);

    if (messageResult.rows.length === 0) {
      throw new Error('Message not found or access denied');
    }

    const message = messageResult.rows[0];

    // 3. Check if already archived
    const archivedCheck = await client.query(
      `SELECT archived_message_id FROM archived_messages
       WHERE ${messageIdColumn} = $1`,
      [messageId]
    );

    if (archivedCheck.rows.length > 0) {
      throw new Error('Message is already archived');
    }

    // 4 & 5. Insert snapshot into archived_messages table
    const archiveParams = [
      messageType === 'agent_message' ? messageId : null, // message_id
      messageType === 'user_message' ? messageId : null,  // user_message_id
      message.agent_id,
      userId,
      messageType,
      message.content,
      message.has_attachments,
      note
    ];

    const archiveResult = await client.query(
      `INSERT INTO archived_messages
       (message_id, user_message_id, agent_id, user_id, message_type,
        content_snapshot, has_attachments, archive_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING archived_message_id, archived_at`,
      archiveParams
    );

    const archivedMessageId = archiveResult.rows[0].archived_message_id;

    // 6. Delete message from appropriate table
    await client.query(
      `DELETE FROM ${messageTable} WHERE ${messageIdColumn} = $1`,
      [messageId]
    );

    await client.query('COMMIT');

    console.log(`Message archived successfully: ${messageId} (type: ${messageType})`);

    return {
      archivedMessageId,
      archivedAt: archiveResult.rows[0].archived_at
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error archiving message:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Unarchive (restore) an archived message
 *
 * Process:
 * 1. Validate archived message exists and belongs to user
 * 2. Get message data from archived_messages
 * 3. Re-create message in appropriate table (messages or user_messages)
 * 4. Delete from archived_messages table
 *
 * Note: Attachments are NOT restored because attachment data is not preserved in archive.
 * Only message content and metadata are restored.
 *
 * @param {string} userId - User ID who owns the archived message
 * @param {string} archivedMessageId - Archived message ID to restore
 * @returns {Promise<Object>} { success: true, messageId: newMessageId }
 * @throws {Error} If archived message not found or not owned by user
 */
async function unarchiveMessage(userId, archivedMessageId) {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 1 & 2. Validate and get archived message data
    const archivedResult = await client.query(
      `SELECT message_id, user_message_id, agent_id, message_type,
              content_snapshot, has_attachments
       FROM archived_messages
       WHERE archived_message_id = $1 AND user_id = $2`,
      [archivedMessageId, userId]
    );

    if (archivedResult.rows.length === 0) {
      throw new Error('Archived message not found or access denied');
    }

    const archived = archivedResult.rows[0];

    // Verify the agent still exists (user could have deleted it)
    const agentCheck = await client.query(
      'SELECT agent_id FROM agents WHERE agent_id = $1 AND user_id = $2',
      [archived.agent_id, userId]
    );

    if (agentCheck.rows.length === 0) {
      throw new Error('Cannot restore message: associated agent no longer exists');
    }

    // 3. Re-create message in appropriate table
    let restoreResult;
    let newMessageId;

    if (archived.message_type === 'agent_message') {
      // Restore to messages table
      // Note: we restore as a simple 'message' type (not 'question')
      // because we don't have question options stored
      const encrypted = archived.encrypted || false;

      restoreResult = await client.query(
        `INSERT INTO messages (message_id, agent_id, message_type, content, encrypted)
         VALUES ($1, $2, 'message', $3, $4)
         RETURNING message_id, created_at`,
        [archived.message_id, archived.agent_id, archived.content_snapshot, encrypted]
      );

      newMessageId = restoreResult.rows[0].message_id;

    } else if (archived.message_type === 'user_message') {
      // Restore to user_messages table
      const encrypted = archived.encrypted || false;

      restoreResult = await client.query(
        `INSERT INTO user_messages (user_message_id, agent_id, content, encrypted)
         VALUES ($1, $2, $3, $4)
         RETURNING user_message_id, created_at`,
        [archived.user_message_id, archived.agent_id, archived.content_snapshot, encrypted]
      );

      newMessageId = restoreResult.rows[0].user_message_id;

    } else {
      throw new Error(`Unknown message_type: ${archived.message_type}`);
    }

    // 4. Delete from archived_messages table
    await client.query(
      'DELETE FROM archived_messages WHERE archived_message_id = $1',
      [archivedMessageId]
    );

    await client.query('COMMIT');

    console.log(`Message unarchived successfully: ${newMessageId} (type: ${archived.message_type})`);

    return {
      success: true,
      messageId: newMessageId,
      messageType: archived.message_type
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error unarchiving message:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get list of archived agents for a user (with pagination)
 *
 * @param {string} userId - User ID
 * @param {Object} options - Query options { limit, offset }
 * @returns {Promise<Object>} { archivedAgents: [...], total: number }
 */
async function getArchivedAgents(userId, { limit = 50, offset = 0 } = {}) {
  try {
    // Get total count
    const countResult = await query(
      'SELECT COUNT(*) AS total FROM archived_agents WHERE user_id = $1',
      [userId]
    );

    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated list
    const result = await query(
      `SELECT archived_agent_id, agent_id, agent_name, agent_type,
              total_messages, archive_reason, archived_at
       FROM archived_agents
       WHERE user_id = $1
       ORDER BY archived_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return {
      archivedAgents: result.rows,
      total,
      limit,
      offset
    };

  } catch (error) {
    console.error('Error getting archived agents:', error);
    throw error;
  }
}

/**
 * Get details of a specific archived agent
 *
 * @param {string} userId - User ID
 * @param {string} archivedAgentId - Archived agent ID
 * @returns {Promise<Object>} Archived agent details
 * @throws {Error} If archived agent not found or access denied
 */
async function getArchivedAgentDetails(userId, archivedAgentId) {
  try {
    const result = await query(
      `SELECT archived_agent_id, agent_id, agent_name, agent_type,
              total_messages, archive_reason, archived_at
       FROM archived_agents
       WHERE archived_agent_id = $1 AND user_id = $2`,
      [archivedAgentId, userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Archived agent not found or access denied');
    }

    return result.rows[0];

  } catch (error) {
    console.error('Error getting archived agent details:', error);
    throw error;
  }
}

/**
 * Get list of archived messages for a user (with optional agent filter and pagination)
 *
 * @param {string} userId - User ID
 * @param {Object} options - Query options { agentId, limit, offset }
 * @returns {Promise<Object>} { archivedMessages: [...], total: number }
 */
async function getArchivedMessages(userId, { agentId = null, limit = 50, offset = 0 } = {}) {
  try {
    // Build query based on whether agentId filter is provided
    let countQuery, dataQuery, params;

    if (agentId) {
      countQuery = `
        SELECT COUNT(*) AS total FROM archived_messages
        WHERE user_id = $1 AND agent_id = $2
      `;
      dataQuery = `
        SELECT archived_message_id, message_id, user_message_id, agent_id,
               message_type, content_snapshot, has_attachments, archive_note, archived_at
        FROM archived_messages
        WHERE user_id = $1 AND agent_id = $2
        ORDER BY archived_at DESC
        LIMIT $3 OFFSET $4
      `;
      params = [userId, agentId];
    } else {
      countQuery = `
        SELECT COUNT(*) AS total FROM archived_messages
        WHERE user_id = $1
      `;
      dataQuery = `
        SELECT archived_message_id, message_id, user_message_id, agent_id,
               message_type, content_snapshot, has_attachments, archive_note, archived_at
        FROM archived_messages
        WHERE user_id = $1
        ORDER BY archived_at DESC
        LIMIT $2 OFFSET $3
      `;
      params = [userId];
    }

    // Get total count
    const countResult = await query(countQuery, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated list
    const dataParams = agentId
      ? [...params, limit, offset]
      : [...params, limit, offset];

    const result = await query(dataQuery, dataParams);

    return {
      archivedMessages: result.rows,
      total,
      limit,
      offset
    };

  } catch (error) {
    console.error('Error getting archived messages:', error);
    throw error;
  }
}

/**
 * Check if an agent is archived
 * Gracefully handles missing archive tables (during migration)
 *
 * @param {string} agentId - Agent ID to check
 * @returns {Promise<boolean>} true if archived, false if not or tables don't exist yet
 */
async function isAgentArchived(agentId) {
  try {
    const result = await query(
      'SELECT archived_agent_id FROM archived_agents WHERE agent_id = $1',
      [agentId]
    );

    return result.rows.length > 0;

  } catch (error) {
    // If archived_agents table doesn't exist yet, archive feature is not ready
    // Return false to allow normal operation during migration
    if (error.code === '42P01') { // PostgreSQL "relation does not exist" error
      console.warn('Archive tables not yet initialized, assuming agent is not archived');
      return false;
    }

    console.error('Error checking if agent is archived:', error);
    throw error;
  }
}

/**
 * Check if a message is archived
 * Gracefully handles missing archive tables (during migration)
 *
 * @param {string} messageId - Message ID to check (message_id or user_message_id)
 * @param {string} messageType - Type: 'agent_message' or 'user_message'
 * @returns {Promise<boolean>} true if archived, false if not or tables don't exist yet
 */
async function isMessageArchived(messageId, messageType) {
  try {
    if (!['agent_message', 'user_message'].includes(messageType)) {
      throw new Error('Invalid messageType. Must be "agent_message" or "user_message"');
    }
    const column = messageType === 'agent_message' ? 'message_id' : 'user_message_id';

    const result = await query(
      `SELECT archived_message_id FROM archived_messages WHERE ${column} = $1`,
      [messageId]
    );

    return result.rows.length > 0;

  } catch (error) {
    // If archived_messages table doesn't exist yet, archive feature is not ready
    // Return false to allow normal operation during migration
    if (error.code === '42P01') { // PostgreSQL "relation does not exist" error
      console.warn('Archive tables not yet initialized, assuming message is not archived');
      return false;
    }

    console.error('Error checking if message is archived:', error);
    throw error;
  }
}

module.exports = {
  archiveAgent,
  unarchiveAgent,
  archiveMessage,
  unarchiveMessage,
  getArchivedAgents,
  getArchivedAgentDetails,
  getArchivedMessages,
  isAgentArchived,
  isMessageArchived
};
