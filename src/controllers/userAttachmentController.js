/**
 * User Attachment Controller
 * Handles upload of encrypted image attachments from users
 *
 * Security notes:
 * - The server only stores encrypted ciphertext bytes
 * - Decryption happens client-side with the shared secret
 * - Files are validated for size and content type before storage
 */

const crypto = require('crypto');
const multer = require('multer');
const { query } = require('../db/connection');
const { isValidUUID } = require('../utils/validation');
const {
  validationError,
  forbiddenError,
  handleDatabaseError,
  internalError
} = require('../utils/errorHandler');
const { logUnauthorizedAccess } = require('../utils/securityLogger');
const { logInfo, logWarn, logError } = require('../utils/logger');
const { getStorageProvider, initializeStorage } = require('../storage');

/**
 * Constants - configurable via environment variables
 */
const MAX_IMAGE_SIZE_MB = parseInt(process.env.MAX_IMAGE_SIZE_MB || '20', 10);
const MAX_IMAGE_BYTES = MAX_IMAGE_SIZE_MB * 1_000_000; // Default 20MB for 4K support
const MAX_IMAGES_PER_USER = parseInt(process.env.MAX_IMAGES_PER_USER || '10', 10);
const MAX_FILENAME_LENGTH = 200;


/**
 * Feature flag for general file uploads (PDFs, text, archives, etc.)
 * Set ENABLE_GENERAL_FILE_UPLOADS=true in .env to enable
 * When disabled, only images are accepted (prevents API bypass)
 */
const ENABLE_GENERAL_FILE_UPLOADS = process.env.ENABLE_GENERAL_FILE_UPLOADS === 'true';

/**
 * Allowed content types for file uploads
 * When ENABLE_GENERAL_FILE_UPLOADS is false, only images are allowed
 */
const ALLOWED_CONTENT_TYPES = ENABLE_GENERAL_FILE_UPLOADS
  ? [
    // Images
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    // Documents
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    // Archives
    'application/zip',
    'application/gzip',
    'application/x-tar',
    // Code/Data
    'application/json',
    'application/xml',
    'text/xml',
    'text/html',
    'text/css',
    'text/javascript',
    'application/javascript',
    // Generic binary (fallback for unknown types)
    'application/octet-stream'
  ]
  : [
    // Images only (default - more restrictive)
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif'
  ];

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
 * Validate that a string is valid base64
 * @param {string} str - String to validate
 * @returns {boolean} True if valid base64
 */
function isValidBase64(str) {
  if (!str || typeof str !== 'string') {
    return false;
  }
  // Base64 regex: allows standard base64 and URL-safe base64
  const base64Regex = /^[A-Za-z0-9+/=_-]+$/;
  if (!base64Regex.test(str)) {
    return false;
  }
  // Check length is reasonable for IV (12 bytes) and auth tag (16 bytes)
  // Base64 encoding: 12 bytes -> 16 chars, 16 bytes -> 24 chars (with padding)
  try {
    const decoded = Buffer.from(str, 'base64');
    return decoded.length > 0 && decoded.length <= 32;
  } catch {
    return false;
  }
}

/**
 * Sanitize filename - remove path components and limit length
 * @param {string} filename - Original filename
 * @returns {string} Sanitized filename
 */
function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return null;
  }

  // Remove any path components (both Unix and Windows style)
  let sanitized = filename.replace(/^.*[/\\]/, '');

  // Remove null bytes and other control characters
  sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, '');

  // Replace directory traversal attempts
  sanitized = sanitized.replace(/\.\./g, '');

  // Limit length
  if (sanitized.length > MAX_FILENAME_LENGTH) {
    // Keep extension if present
    const lastDot = sanitized.lastIndexOf('.');
    if (lastDot > 0 && lastDot > sanitized.length - 10) {
      const ext = sanitized.slice(lastDot);
      const name = sanitized.slice(0, MAX_FILENAME_LENGTH - ext.length);
      sanitized = name + ext;
    } else {
      sanitized = sanitized.slice(0, MAX_FILENAME_LENGTH);
    }
  }

  return sanitized.trim() || null;
}

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
 * Cleanup oldest user images when limit is exceeded
 * Deletes the oldest attachments for a user to make room for new ones
 * @param {string} userId - User ID to check
 * @param {Object} storage - Storage provider instance
 * @returns {Promise<number>} Number of attachments deleted
 */
async function cleanupOldestUserImages(userId, storage) {
  try {
    // Count user's total attachments across all their agents
    const countResult = await query(`
      SELECT COUNT(*) as total
      FROM attachments a
      JOIN agents ag ON a.agent_id = ag.agent_id
      WHERE ag.user_id = $1
    `, [userId]);

    const totalAttachments = parseInt(countResult.rows[0].total, 10);

    // If under limit, no cleanup needed
    if (totalAttachments < MAX_IMAGES_PER_USER) {
      return 0;
    }

    // Calculate how many to delete (delete enough to make room for 1 new image)
    const toDelete = totalAttachments - MAX_IMAGES_PER_USER + 1;

    // Get the oldest attachments to delete
    const oldestResult = await query(`
      SELECT a.attachment_id, a.storage_key
      FROM attachments a
      JOIN agents ag ON a.agent_id = ag.agent_id
      WHERE ag.user_id = $1
      ORDER BY a.created_at ASC
      LIMIT $2
    `, [userId, toDelete]);

    let deletedCount = 0;
    for (const row of oldestResult.rows) {
      try {
        // Delete from storage first
        await storage.delete(row.storage_key);

        // Delete from database
        await query('DELETE FROM attachments WHERE attachment_id = $1', [row.attachment_id]);

        deletedCount++;
        logInfo('attachment_auto_deleted', {
          attachmentId: row.attachment_id,
          userId,
          reason: 'per_user_limit_exceeded'
        });
      } catch (deleteError) {
        logError('attachment_auto_delete_error', {
          attachmentId: row.attachment_id,
          error: deleteError.message
        });
      }
    }

    if (deletedCount > 0) {
      logInfo('user_attachments_cleanup', {
        userId,
        deletedCount,
        previousTotal: totalAttachments,
        limit: MAX_IMAGES_PER_USER
      });
    }

    return deletedCount;
  } catch (error) {
    logError('attachment_cleanup_error', {
      userId,
      error: error.message
    });
    // Don't throw - cleanup failure shouldn't block upload
    return 0;
  }
}

/**

 * Upload an encrypted attachment
 * POST /api/user/attachments
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
        logError('attachment_upload_multer_error', { error: multerErr.message });
        return internalError(res, 'Failed to process upload');
      }

      const userId = req.user.userId;

      // Validate required fields from form data
      const { agentId, ivBase64, authTagBase64, contentType, width, height, sha256 } = req.body;

      // Validate agentId
      if (!agentId) {
        return validationError(res, 'Agent ID is required');
      }
      if (!isValidUUID(agentId)) {
        return validationError(res, 'Invalid agent ID format');
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

      // Validate user owns the agent
      const agentResult = await query(
        'SELECT agent_id FROM agents WHERE agent_id = $1 AND user_id = $2',
        [agentId, userId]
      );

      if (agentResult.rows.length === 0) {
        logUnauthorizedAccess(req, 'agent', agentId, 'User does not own this agent');
        return forbiddenError(res, 'You do not have access to this agent');
      }

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


      // Insert attachment record into database
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
          'user' // uploaded_by
        ]
      );

      logInfo('attachment_uploaded', {
        attachmentId,
        agentId,
        userId,
        contentType,
        sizeBytes: req.file.buffer.length
      });

      // Return response (wrapped in 'attachment' object for frontend compatibility)
      res.status(201).json({
        attachment: {
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
        }
      });

    } catch (error) {
      logError('attachment_upload_error', {
        error: error.message,
        stack: error.stack
      });
      return handleDatabaseError(res, error, 'uploading attachment');
    }
  });
}

/**
 * Download an encrypted attachment
 * GET /api/user/attachments/:attachmentId
 *
 * Authorization: User must own the agent that this attachment is associated with.
 * The attachment can be linked via:
 * - Direct agent_id on the attachment (for user uploads)
 * - message_attachments join table -> messages -> agents
 * - user_message_attachments join table -> user_messages -> agents
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

    // Look up attachment and verify user has access through any path:
    // 1. Direct agent_id on attachment (for user-uploaded attachments)
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
      // Check if attachment exists at all (to distinguish 404 from 403)
      const existsResult = await query(
        'SELECT attachment_id FROM attachments WHERE attachment_id = $1',
        [attachmentId]
      );

      if (existsResult.rows.length === 0) {
        // Attachment doesn't exist - return 404
        logWarn('attachment_download_not_found', { attachmentId, userId });
        return res.status(404).json({
          error: {
            code: 'ATTACHMENT_NOT_FOUND',
            message: 'Attachment not found'
          }
        });
      }

      // Attachment exists but user doesn't have access - return 404 to avoid leaking info
      logUnauthorizedAccess(req, 'attachment', attachmentId, 'User does not have access to this attachment');
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
      logWarn('attachment_download_no_stream', {
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
        logError('attachment_download_retrieve_error', {
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

      logInfo('attachment_download_started', {
        attachmentId,
        userId,
        sizeBytes
      });

      // Handle stream errors
      stream.on('error', (streamError) => {
        logError('attachment_download_stream_error', {
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
      logError('attachment_download_stream_create_error', {
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
    logError('attachment_download_error', {
      error: error.message,
      stack: error.stack
    });
    return handleDatabaseError(res, error, 'downloading attachment');
  }
}

module.exports = {
  uploadAttachment,
  downloadAttachment,
  uploadMiddleware,
  // Export constants for testing and reuse
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_USER,
  MAX_IMAGE_SIZE_MB,
  ALLOWED_CONTENT_TYPES,
  // Export helpers for testing and reuse
  isValidBase64,
  sanitizeFilename,
  cleanupOldestUserImages
};

