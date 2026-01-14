/**
 * Agent Attachment Controller
 * Handles upload of encrypted image attachments from agents (API key auth)
 *
 * Security notes:
 * - The server only stores encrypted ciphertext bytes
 * - Decryption happens client-side with the shared secret
 * - Files are validated for size and content type before storage
 * - Uses API key authentication (agents identify by name)
 */

const crypto = require('crypto');
const multer = require('multer');
const { query } = require('../db/connection');
const { validateAgentName, isValidUUID } = require('../utils/validation');
const {
  validationError,
  forbiddenError,
  handleDatabaseError,
  internalError
} = require('../utils/errorHandler');
const { logUnauthorizedAccess } = require('../utils/securityLogger');
const { logInfo, logWarn, logError } = require('../utils/logger');
const { initializeStorage } = require('../storage');

// Import shared helpers from userAttachmentController
const {
  MAX_IMAGE_BYTES,
  ALLOWED_CONTENT_TYPES,
  isValidBase64,
  sanitizeFilename,
  cleanupOldestUserImages
} = require('./userAttachmentController');


/**
 * Configure multer for memory storage (we handle file storage ourselves)
 * Using memory storage since files are encrypted and need to go to our custom storage
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1
  }
});

/**
 * Multer middleware for single file upload
 */
const uploadMiddleware = upload.single('file');

/**
 * Handle multer errors and convert them to our standard error format
 * @param {Error} err - Multer error
 * @param {Object} res - Express response
 * @returns {boolean} True if error was handled
 */
function handleMulterError(err, res) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      validationError(res, `File size exceeds maximum of ${MAX_IMAGE_BYTES / 1_000_000}MB`);
      return true;
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      validationError(res, 'Only one file can be uploaded at a time');
      return true;
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      validationError(res, 'Unexpected field in upload request');
      return true;
    }
    validationError(res, `Upload error: ${err.message}`);
    return true;
  }
  return false;
}

/**
 * Upload an encrypted attachment from an agent
 * POST /api/agent/attachments
 *
 * @param {Object} req - Express request with multipart form data
 * @param {Object} res - Express response
 */
async function uploadAttachment(req, res) {
  // Wrap multer in a promise for better error handling
  uploadMiddleware(req, res, async (multerErr) => {
    try {
      // Handle multer errors
      if (multerErr) {
        if (handleMulterError(multerErr, res)) {
          return;
        }
        logError('agent_attachment_upload_multer_error', { error: multerErr.message });
        return internalError(res, 'Failed to process upload');
      }

      const userId = req.user.userId;

      // Validate required fields from form data
      const { agentName, ivBase64, authTagBase64, contentType, width, height, sha256 } = req.body;

      // Validate agentName (agents identify themselves by name)
      if (!agentName) {
        return validationError(res, 'Agent name is required');
      }
      const agentNameValidation = validateAgentName(agentName);
      if (!agentNameValidation.valid) {
        return validationError(res, agentNameValidation.message);
      }

      // Validate file was uploaded
      if (!req.file) {
        return validationError(res, 'File is required');
      }

      // Validate encryption metadata
      if (!ivBase64) {
        return validationError(res, 'IV (ivBase64) is required');
      }
      if (!isValidBase64(ivBase64)) {
        return validationError(res, 'Invalid ivBase64 format');
      }

      if (!authTagBase64) {
        return validationError(res, 'Auth tag (authTagBase64) is required');
      }
      if (!isValidBase64(authTagBase64)) {
        return validationError(res, 'Invalid authTagBase64 format');
      }

      // Validate content type
      if (!contentType) {
        return validationError(res, 'Content type is required');
      }
      if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
        return validationError(res, `Content type must be one of: ${ALLOWED_CONTENT_TYPES.join(', ')}`);
      }

      // Verify agent exists and belongs to authenticated user (via agentName)
      const agentResult = await query(
        'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_name = $2',
        [userId, agentName]
      );

      if (agentResult.rows.length === 0) {
        logWarn('agent_attachment_upload_agent_not_found', {
          userId,
          agentName
        });
        return forbiddenError(res, 'Agent not found or you do not have access to it');
      }

      const agentId = agentResult.rows[0].agent_id;

      // Validate optional numeric fields
      let parsedWidth = null;
      let parsedHeight = null;

      if (width !== undefined && width !== null && width !== '') {
        parsedWidth = parseInt(width, 10);
        if (isNaN(parsedWidth) || parsedWidth < 1 || parsedWidth > 100000) {
          return validationError(res, 'Invalid width value');
        }
      }

      if (height !== undefined && height !== null && height !== '') {
        parsedHeight = parseInt(height, 10);
        if (isNaN(parsedHeight) || parsedHeight < 1 || parsedHeight > 100000) {
          return validationError(res, 'Invalid height value');
        }
      }

      // Validate optional sha256 hash
      let validatedSha256 = null;
      if (sha256 !== undefined && sha256 !== null && sha256 !== '') {
        // SHA-256 is 64 hex characters
        if (!/^[a-fA-F0-9]{64}$/.test(sha256)) {
          return validationError(res, 'Invalid sha256 format (expected 64 hex characters)');
        }
        validatedSha256 = sha256.toLowerCase();
      }

      // Sanitize filename (from multer's originalname)
      const sanitizedFilename = sanitizeFilename(req.file.originalname);

      // Generate attachment ID
      const attachmentId = crypto.randomUUID();

      // Get storage provider and store the encrypted bytes
      const storage = await initializeStorage();

      // Cleanup oldest images if user is at limit
      await cleanupOldestUserImages(userId, storage);

      const storageKey = await storage.store(
        req.file.buffer,
        attachmentId,
        userId,
        agentId
      );


      // Insert attachment record into database with uploaded_by='agent'
      const insertResult = await query(
        `INSERT INTO attachments (
          attachment_id,
          content_type,
          file_name,
          size_bytes,
          sha256,
          storage_provider,
          storage_key,
          encrypted,
          width,
          height,
          iv_base64,
          auth_tag_base64,
          agent_id,
          uploaded_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING attachment_id, created_at`,
        [
          attachmentId,
          contentType,
          sanitizedFilename,
          req.file.buffer.length,
          validatedSha256,
          'local', // storage provider type
          storageKey,
          true, // encrypted
          parsedWidth,
          parsedHeight,
          ivBase64,
          authTagBase64,
          agentId,
          'agent' // uploaded_by - this is the key difference from user uploads
        ]
      );

      // Update last_seen_at for this agent (tracks when agent was last active)
      await query('UPDATE agents SET last_seen_at = NOW() WHERE agent_id = $1', [agentId]);

      logInfo('agent_attachment_uploaded', {
        attachmentId,
        agentId,
        agentName,
        userId,
        contentType,
        sizeBytes: req.file.buffer.length
      });

      // Return response (same format as user endpoint)
      res.status(201).json({
        attachmentId: insertResult.rows[0].attachment_id,
        contentType: contentType,
        sizeBytes: req.file.buffer.length,
        width: parsedWidth,
        height: parsedHeight,
        encrypted: true,
        encryption: {
          alg: 'AES-GCM',
          ivBase64: ivBase64,
          tagBase64: authTagBase64
        }
      });

    } catch (error) {
      logError('agent_attachment_upload_error', {
        error: error.message,
        stack: error.stack
      });
      return handleDatabaseError(res, error, 'uploading attachment');
    }
  });
}

/**
 * Download an encrypted attachment for an agent
 * GET /api/agent/attachments/:attachmentId
 *
 * Authorization: The agent that the attachment is associated with must belong
 * to the authenticated user (via API key). The attachment can be linked via:
 * - Direct agent_id on the attachment
 * - message_attachments join table -> messages -> agents
 * - user_message_attachments join table -> user_messages -> agents
 *
 * Returns 404 for both missing and unauthorized to avoid leaking existence.
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
async function downloadAttachment(req, res) {
  try {
    const userId = req.user.userId;
    const { attachmentId } = req.params;

    // Validate attachmentId format
    if (!isValidUUID(attachmentId)) {
      return validationError(res, 'Invalid attachment ID format');
    }

    // Look up attachment and verify agent belongs to authenticated user through any path:
    // 1. Direct agent_id on attachment
    // 2. Through message_attachments -> messages -> agents
    // 3. Through user_message_attachments -> user_messages -> agents
    const accessResult = await query(`
      SELECT
        a.attachment_id,
        a.content_type,
        a.file_name,
        a.size_bytes,
        a.storage_provider,
        a.storage_key
      FROM attachments a
      LEFT JOIN agents ag ON a.agent_id = ag.agent_id
      LEFT JOIN message_attachments ma ON a.attachment_id = ma.attachment_id
      LEFT JOIN messages m ON ma.message_id = m.message_id
      LEFT JOIN agents ag2 ON m.agent_id = ag2.agent_id
      LEFT JOIN user_message_attachments uma ON a.attachment_id = uma.attachment_id
      LEFT JOIN user_messages um ON uma.user_message_id = um.user_message_id
      LEFT JOIN agents ag3 ON um.agent_id = ag3.agent_id
      WHERE a.attachment_id = $1
        AND (
          ag.user_id = $2
          OR ag2.user_id = $2
          OR ag3.user_id = $2
        )
      LIMIT 1
    `, [attachmentId, userId]);

    if (accessResult.rows.length === 0) {
      // Return 404 for both missing and unauthorized to avoid leaking existence
      logWarn('agent_attachment_download_not_found_or_unauthorized', { attachmentId, userId });
      return res.status(404).json({
        error: {
          code: 'ATTACHMENT_NOT_FOUND',
          message: 'Attachment not found'
        }
      });
    }

    const attachment = accessResult.rows[0];
    const { storage_key: storageKey, size_bytes: sizeBytes, file_name: fileName } = attachment;

    // Get storage provider and create read stream
    const storage = await initializeStorage();

    // Check if storage provider supports streaming
    if (typeof storage.createReadStream !== 'function') {
      // Fall back to loading entire file into memory
      logWarn('agent_attachment_download_no_stream', {
        attachmentId,
        provider: storage.name
      });

      try {
        const buffer = await storage.retrieve(storageKey);

        res.set({
          'Content-Type': 'application/octet-stream',
          'Content-Length': sizeBytes,
          'Cache-Control': 'private, max-age=3600'
        });

        if (fileName) {
          // Sanitize filename for Content-Disposition header
          const safeFileName = sanitizeFilename(fileName) || 'attachment';
          res.set('Content-Disposition', `inline; filename="${safeFileName}"`);
        }

        return res.send(buffer);
      } catch (storageError) {
        logError('agent_attachment_download_retrieve_error', {
          attachmentId,
          error: storageError.message
        });

        if (storageError.message === 'File not found') {
          return res.status(404).json({
            error: {
              code: 'ATTACHMENT_NOT_FOUND',
              message: 'Attachment file not found in storage'
            }
          });
        }

        return internalError(res, 'Failed to retrieve attachment');
      }
    }

    // Use streaming for better memory efficiency
    try {
      const { stream } = await storage.createReadStream(storageKey);

      // Set response headers
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Length': sizeBytes,
        'Cache-Control': 'private, max-age=3600'
      });

      if (fileName) {
        // Sanitize filename for Content-Disposition header
        const safeFileName = sanitizeFilename(fileName) || 'attachment';
        res.set('Content-Disposition', `inline; filename="${safeFileName}"`);
      }

      logInfo('agent_attachment_download_started', {
        attachmentId,
        userId,
        sizeBytes
      });

      // Handle stream errors
      stream.on('error', (streamError) => {
        logError('agent_attachment_download_stream_error', {
          attachmentId,
          error: streamError.message,
          code: streamError.code
        });

        // If headers haven't been sent yet, send error response
        if (!res.headersSent) {
          if (streamError.code === 'ENOENT') {
            return res.status(404).json({
              error: {
                code: 'ATTACHMENT_NOT_FOUND',
                message: 'Attachment file not found in storage'
              }
            });
          }
          return internalError(res, 'Failed to stream attachment');
        }

        // Headers already sent, destroy the response
        res.destroy();
      });

      // Pipe the stream to the response
      stream.pipe(res);

    } catch (storageError) {
      logError('agent_attachment_download_stream_create_error', {
        attachmentId,
        error: storageError.message
      });

      if (storageError.message === 'File not found') {
        return res.status(404).json({
          error: {
            code: 'ATTACHMENT_NOT_FOUND',
            message: 'Attachment file not found in storage'
          }
        });
      }

      if (storageError.message.includes('permission denied')) {
        return internalError(res, 'Storage permission error');
      }

      return internalError(res, 'Failed to retrieve attachment');
    }

  } catch (error) {
    logError('agent_attachment_download_error', {
      error: error.message,
      stack: error.stack
    });
    return handleDatabaseError(res, error, 'downloading attachment');
  }
}

module.exports = {
  uploadAttachment,
  downloadAttachment,
  uploadMiddleware
};
