/**
 * Agent Attachment Controller
 * Handles upload of encrypted attachments from agents (API key auth)
 *
 * Security notes:
 * - The server only stores encrypted ciphertext bytes
 * - Decryption happens client-side with the shared secret
 * - Files are validated for size and content type before storage
 * - Uses API key authentication (agents identify by name)
 */

const crypto = require('crypto');
const multer = require('multer');
const { query, getClient } = require('../db/connection');
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
  ENABLE_GENERAL_FILE_UPLOADS,
  CONTENT_TYPE_PATTERN,
  IMAGE_CONTENT_TYPES,
  isValidBase64,
  sanitizeFilename,
  cleanupOldestUserImages
} = require('./userAttachmentController');


/**
 * Configure multer for memory storage (we handle file storage ourselves)
 * Using memory storage since files are encrypted and need to go to our custom storage.
 *
 * The fileFilter rejects disallowed MIME types up front so we don't buffer
 * megabytes of bytes into memory only to throw them away in the controller.
 * Note: this is defense-in-depth — the controller still re-validates the
 * declared contentType field from the form body.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype || '').trim().toLowerCase();
    if (!CONTENT_TYPE_PATTERN.test(mime)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'invalid content-type'));
    }
    if (!ENABLE_GENERAL_FILE_UPLOADS && !IMAGE_CONTENT_TYPES.has(mime)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'only image uploads allowed'));
    }
    cb(null, true);
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
    let uploadLock;
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

      // Multipart fields are parsed after authentication middleware runs.
      // Bind the parsed identity here as well, before storing any bytes.
      if (req.authContext?.type === 'agent_token' && agentName !== req.authContext.agentName) {
        return forbiddenError(res, 'Attachment uploads must use the paired agent identity');
      }

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
      const normalizedContentType = String(contentType || '').trim() || 'application/octet-stream';
      if (!CONTENT_TYPE_PATTERN.test(normalizedContentType)) {
        return validationError(res, 'Invalid content type format');
      }
      if (!ENABLE_GENERAL_FILE_UPLOADS && !IMAGE_CONTENT_TYPES.has(normalizedContentType)) {
        return validationError(res, 'Only image attachments are currently allowed');
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
      const encryptionPeerId = req.body.encryptionPeerId || null;
      if (encryptionPeerId && (!isValidUUID(encryptionPeerId) || !await require('../services/peerAttachmentService').permitted(userId, agentId, encryptionPeerId))) return forbiddenError(res, 'Attachment peer encryption requires a currently permitted peer');

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
      const attachmentId = req.body.clientAttachmentId || crypto.randomUUID();

      // Get storage provider and store the encrypted bytes
      const storage = await initializeStorage();

      // Hosted MCP retries keep the same ciphertext and upload UUID across
      // restarts. Serialize that UUID before touching storage to avoid an
      // uncertain retry overwriting an already committed encrypted file.
      if (req.body.clientAttachmentId !== undefined) {
        if (!isValidUUID(req.body.clientAttachmentId) || !validatedSha256) return validationError(res, 'clientAttachmentId requires a UUID and SHA-256');
        uploadLock = await getClient();
        await uploadLock.query('SELECT pg_advisory_lock(hashtext($1))', [req.body.clientAttachmentId]);
        const previous = await query('SELECT * FROM attachments WHERE attachment_id=$1', [req.body.clientAttachmentId]);
        if (previous.rows[0]) {
          const old = previous.rows[0];
          const matches = old.agent_id === agentId && old.sha256 === validatedSha256 && old.content_type === normalizedContentType
            && old.file_name === sanitizedFilename && Number(old.size_bytes) === req.file.buffer.length
            && old.iv_base64 === ivBase64 && old.auth_tag_base64 === authTagBase64 && (old.encryption_peer_id || null) === encryptionPeerId;
          if (!matches || !(await storage.retrieve(old.storage_key)).equals(req.file.buffer)) return res.status(409).json({ error: { code: 'ATTACHMENT_ID_CONFLICT' } });
          return res.json({ attachmentId: old.attachment_id, contentType: old.content_type, sizeBytes: Number(old.size_bytes), encrypted: true, idempotent: true,
            encryption: { alg: 'AES-GCM', ivBase64: old.iv_base64, tagBase64: old.auth_tag_base64 } });
        }
      }

      // Cleanup oldest images if user is at limit
      await cleanupOldestUserImages(userId, storage);

      const storageKey = await storage.store(
        req.file.buffer,
        req.body.clientAttachmentId || attachmentId,
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
          uploaded_by, encryption_peer_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING attachment_id, created_at`,
        [
          req.body.clientAttachmentId || attachmentId,
          normalizedContentType,
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
          'agent', // uploaded_by - this is the key difference from user uploads
          encryptionPeerId
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
        code: error.code,
        detail: error.detail,
        stack: error.stack
      });

      // Distinguish storage errors from database errors
      if (error.message && (
        error.message.startsWith('Storage failed:') ||
        error.message.startsWith('Failed to initialize storage')
      )) {
        return internalError(res, error.message);
      }

      return handleDatabaseError(res, error, 'uploading attachment');
    } finally {
      if (uploadLock) {
        try { await uploadLock.query('SELECT pg_advisory_unlock(hashtext($1))', [req.body.clientAttachmentId]); }
        catch (_error) { logWarn('agent_attachment_upload_unlock_failed', {}); }
        finally { uploadLock.release(); }
      }
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
async function findAccessibleAttachment(req, attachmentId) {
  const userId = req.user.userId;
  const accessResult = await query(`
      SELECT
        a.attachment_id,
        a.content_type,
        a.file_name,
        a.size_bytes,
        a.storage_provider,
        a.storage_key, a.encrypted, a.iv_base64, a.auth_tag_base64, a.width, a.height, a.encryption_peer_id
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
          (ag.user_id = $2 AND ($3::uuid IS NULL OR ag.agent_id = $3))
          OR (ag2.user_id = $2 AND ($3::uuid IS NULL OR ag2.agent_id = $3))
          OR (ag3.user_id = $2 AND ($3::uuid IS NULL OR ag3.agent_id = $3))
        )
      LIMIT 1
    `, [attachmentId, userId, req.authContext?.type === 'agent_token' ? req.authContext.agentId : null]);
  if (!accessResult.rows.length) {
    const shared = await require('../services/peerAttachmentService').accessible(req, attachmentId);
    if (shared) accessResult.rows.push(shared);
  }
  return accessResult;
}

async function attachmentMetadata(req, res) {
  try {
    if (!isValidUUID(req.params.attachmentId)) return validationError(res, "Invalid attachment ID format");
    const result = await findAccessibleAttachment(req, req.params.attachmentId);
    if (!result.rows[0]) return res.status(404).json({ error: { code: "ATTACHMENT_NOT_FOUND" } });
    const a = result.rows[0];
    return res.set("Cache-Control", "no-store").json({ attachmentId: a.attachment_id, fileName: a.file_name, contentType: a.content_type, sizeBytes: Number(a.size_bytes), encrypted: a.encrypted, peerAgentId: a.peer_agent_id || null, encryptionPeerId: a.encryption_peer_id || null, width: a.width, height: a.height, encryption: a.encrypted ? { alg: "AES-GCM", ivBase64: a.iv_base64, tagBase64: a.auth_tag_base64 } : null });
  } catch (error) { return handleDatabaseError(res, error, "reading attachment metadata"); }
}

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
    const accessResult = await findAccessibleAttachment(req, attachmentId);

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
  attachmentMetadata,
  uploadMiddleware
};
