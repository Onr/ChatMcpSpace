/**
 * Local Storage Provider
 * Stores encrypted image attachments on the local filesystem
 *
 * Files are stored under: ./uploads/<userId>/<agentId>/<attachmentId>
 * This provider never decrypts data - it stores only ciphertext bytes.
 *
 * Security considerations:
 * - Files are NOT served from public/ (must enforce auth separately)
 * - Paths are sanitized to prevent directory traversal attacks
 * - Directories are created with restrictive permissions
 */

const fs = require('fs').promises;
const path = require('path');
const StorageProvider = require('./StorageProvider');
const { logInfo, logWarn, logError } = require('../utils/logger');

/**
 * Regular expression to validate path components
 * Allows alphanumeric characters, hyphens, underscores, and dots (but not leading dots)
 */
const SAFE_PATH_COMPONENT_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_\-\.]*$/;

/**
 * Maximum length for path components to prevent filesystem issues
 */
const MAX_PATH_COMPONENT_LENGTH = 255;

/**
 * Local filesystem storage provider for encrypted attachments
 * @extends StorageProvider
 */
class LocalStorageProvider extends StorageProvider {
  /**
   * Create a new LocalStorageProvider
   * @param {Object} config - Configuration options
   * @param {string} [config.basePath='./uploads'] - Base directory for file storage
   */
  constructor(config = {}) {
    super(config);
    this.basePath = config.basePath || './uploads';
    // Resolve to absolute path to prevent ambiguity
    this.absoluteBasePath = path.resolve(this.basePath);
  }

  /**
   * @inheritdoc
   */
  get name() {
    return 'local';
  }

  /**
   * Sanitize a path component to prevent directory traversal
   * @param {string} component - Path component to sanitize
   * @param {string} paramName - Name of parameter (for error messages)
   * @returns {string} Sanitized component
   * @throws {Error} If component contains invalid characters
   * @private
   */
  sanitizePathComponent(component, paramName) {
    if (!component || typeof component !== 'string') {
      throw new Error(`${paramName} must be a non-empty string`);
    }

    // Trim whitespace
    const trimmed = component.trim();

    // Check length
    if (trimmed.length === 0) {
      throw new Error(`${paramName} cannot be empty or whitespace`);
    }
    if (trimmed.length > MAX_PATH_COMPONENT_LENGTH) {
      throw new Error(`${paramName} exceeds maximum length of ${MAX_PATH_COMPONENT_LENGTH}`);
    }

    // Check for directory traversal attempts
    if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
      logWarn('storage_path_traversal_attempt', { paramName, component: trimmed });
      throw new Error(`${paramName} contains invalid characters (potential path traversal)`);
    }

    // Validate against safe pattern
    if (!SAFE_PATH_COMPONENT_REGEX.test(trimmed)) {
      throw new Error(`${paramName} contains invalid characters. Allowed: alphanumeric, hyphens, underscores, dots (not leading)`);
    }

    return trimmed;
  }

  /**
   * Build the full file path for an attachment
   * @param {string} userId - User ID
   * @param {string} agentId - Agent ID
   * @param {string} attachmentId - Attachment ID
   * @returns {string} Full file path
   * @private
   */
  buildFilePath(userId, agentId, attachmentId) {
    const safeUserId = this.sanitizePathComponent(userId, 'userId');
    const safeAgentId = this.sanitizePathComponent(agentId, 'agentId');
    const safeAttachmentId = this.sanitizePathComponent(attachmentId, 'attachmentId');

    const filePath = path.join(this.absoluteBasePath, safeUserId, safeAgentId, safeAttachmentId);

    // Final safety check: ensure the resolved path is within the base path
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(this.absoluteBasePath)) {
      logError('storage_path_escape_attempt', {
        filePath,
        resolvedPath,
        basePath: this.absoluteBasePath
      });
      throw new Error('Invalid path: attempt to access files outside storage directory');
    }

    return resolvedPath;
  }

  /**
   * Build a storage key from components
   * Storage key format: local:<userId>/<agentId>/<attachmentId>
   * @param {string} userId - User ID
   * @param {string} agentId - Agent ID
   * @param {string} attachmentId - Attachment ID
   * @returns {string} Storage key
   * @private
   */
  buildStorageKey(userId, agentId, attachmentId) {
    return `local:${userId}/${agentId}/${attachmentId}`;
  }

  /**
   * Parse a storage key into its components
   * @param {string} storageKey - Storage key to parse
   * @returns {{userId: string, agentId: string, attachmentId: string}} Parsed components
   * @throws {Error} If storage key format is invalid
   * @private
   */
  parseStorageKey(storageKey) {
    this.validateStorageKey(storageKey);

    if (!storageKey.startsWith('local:')) {
      throw new Error('Invalid storage key: must start with "local:"');
    }

    const keyPath = storageKey.slice(6); // Remove 'local:' prefix
    const parts = keyPath.split('/');

    if (parts.length !== 3) {
      throw new Error('Invalid storage key format: expected local:<userId>/<agentId>/<attachmentId>');
    }

    const [userId, agentId, attachmentId] = parts;

    return {
      userId: this.sanitizePathComponent(userId, 'userId'),
      agentId: this.sanitizePathComponent(agentId, 'agentId'),
      attachmentId: this.sanitizePathComponent(attachmentId, 'attachmentId')
    };
  }

  /**
   * Ensure the directory exists, creating it if necessary
   * @param {string} dirPath - Directory path to create
   * @returns {Promise<void>}
   * @private
   */
  async ensureDirectory(dirPath) {
    try {
      await fs.mkdir(dirPath, { recursive: true, mode: 0o750 });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * @inheritdoc
   */
  async store(buffer, attachmentId, userId, agentId) {
    this.validateStoreParams(buffer, attachmentId, userId, agentId);

    const filePath = this.buildFilePath(userId, agentId, attachmentId);
    const dirPath = path.dirname(filePath);

    try {
      // Create directory structure
      await this.ensureDirectory(dirPath);

      // Write the file
      await fs.writeFile(filePath, buffer, { mode: 0o640 });

      const storageKey = this.buildStorageKey(userId, agentId, attachmentId);

      logInfo('storage_file_stored', {
        provider: this.name,
        storageKey,
        size: buffer.length
      });

      return storageKey;
    } catch (error) {
      // Handle specific errors with helpful messages
      if (error.code === 'ENOSPC') {
        logError('storage_disk_full', {
          provider: this.name,
          attachmentId,
          userId,
          agentId
        });
        throw new Error('Storage failed: disk is full');
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        logError('storage_permission_denied', {
          provider: this.name,
          attachmentId,
          userId,
          agentId,
          path: filePath
        });
        throw new Error('Storage failed: permission denied');
      }
      if (error.code === 'ENAMETOOLONG') {
        logError('storage_name_too_long', {
          provider: this.name,
          attachmentId,
          userId,
          agentId
        });
        throw new Error('Storage failed: filename too long');
      }

      logError('storage_store_failed', {
        provider: this.name,
        attachmentId,
        userId,
        agentId,
        error: error.message,
        code: error.code
      });
      throw new Error(`Storage failed: ${error.message}`);
    }
  }

  /**
   * @inheritdoc
   */
  async retrieve(storageKey) {
    const { userId, agentId, attachmentId } = this.parseStorageKey(storageKey);
    const filePath = this.buildFilePath(userId, agentId, attachmentId);

    try {
      const buffer = await fs.readFile(filePath);

      logInfo('storage_file_retrieved', {
        provider: this.name,
        storageKey,
        size: buffer.length
      });

      return buffer;
    } catch (error) {
      if (error.code === 'ENOENT') {
        logWarn('storage_file_not_found', {
          provider: this.name,
          storageKey
        });
        throw new Error('File not found');
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        logError('storage_retrieve_permission_denied', {
          provider: this.name,
          storageKey
        });
        throw new Error('Retrieve failed: permission denied');
      }

      logError('storage_retrieve_failed', {
        provider: this.name,
        storageKey,
        error: error.message,
        code: error.code
      });
      throw new Error(`Retrieve failed: ${error.message}`);
    }
  }

  /**
   * @inheritdoc
   */
  async delete(storageKey) {
    const { userId, agentId, attachmentId } = this.parseStorageKey(storageKey);
    const filePath = this.buildFilePath(userId, agentId, attachmentId);

    try {
      await fs.unlink(filePath);

      logInfo('storage_file_deleted', {
        provider: this.name,
        storageKey
      });

      // Attempt to clean up empty directories (best effort)
      await this.cleanupEmptyDirectories(userId, agentId);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File already doesn't exist - this is fine for delete operations
        logWarn('storage_delete_file_not_found', {
          provider: this.name,
          storageKey
        });
        return;
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        logError('storage_delete_permission_denied', {
          provider: this.name,
          storageKey
        });
        throw new Error('Delete failed: permission denied');
      }

      logError('storage_delete_failed', {
        provider: this.name,
        storageKey,
        error: error.message,
        code: error.code
      });
      throw new Error(`Delete failed: ${error.message}`);
    }
  }

  /**
   * Create a readable stream for the stored data
   * @param {string} storageKey - Key returned from store()
   * @returns {Promise<{stream: ReadableStream, filePath: string}>} Readable stream and file path
   * @throws {Error} If file not found or permission denied
   */
  async createReadStream(storageKey) {
    const fs = require('fs');
    const { userId, agentId, attachmentId } = this.parseStorageKey(storageKey);
    const filePath = this.buildFilePath(userId, agentId, attachmentId);

    // Check if file exists first
    try {
      await require('fs').promises.access(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        logWarn('storage_file_not_found', {
          provider: this.name,
          storageKey
        });
        throw new Error('File not found');
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        logError('storage_stream_permission_denied', {
          provider: this.name,
          storageKey
        });
        throw new Error('Stream failed: permission denied');
      }
      throw error;
    }

    const stream = fs.createReadStream(filePath);

    logInfo('storage_stream_created', {
      provider: this.name,
      storageKey
    });

    return { stream, filePath };
  }

  /**
   * @inheritdoc
   */
  async exists(storageKey) {
    try {
      const { userId, agentId, attachmentId } = this.parseStorageKey(storageKey);
      const filePath = this.buildFilePath(userId, agentId, attachmentId);

      await fs.access(filePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      // For other errors (invalid key format, etc.), return false
      // but log the issue
      if (error.message && !error.message.includes('Invalid')) {
        logWarn('storage_exists_check_error', {
          provider: this.name,
          storageKey,
          error: error.message
        });
      }
      return false;
    }
  }

  /**
   * Attempt to remove empty directories after file deletion
   * This is a best-effort cleanup - errors are logged but not thrown
   * @param {string} userId - User ID
   * @param {string} agentId - Agent ID
   * @private
   */
  async cleanupEmptyDirectories(userId, agentId) {
    try {
      const agentDir = path.join(this.absoluteBasePath, userId, agentId);
      const userDir = path.join(this.absoluteBasePath, userId);

      // Try to remove agent directory (will fail if not empty)
      try {
        await fs.rmdir(agentDir);
        logInfo('storage_cleanup_removed_dir', { path: agentDir });
      } catch (error) {
        // Directory not empty or other error - ignore
      }

      // Try to remove user directory (will fail if not empty)
      try {
        await fs.rmdir(userDir);
        logInfo('storage_cleanup_removed_dir', { path: userDir });
      } catch (error) {
        // Directory not empty or other error - ignore
      }
    } catch (error) {
      // Cleanup is best-effort, don't throw
      logWarn('storage_cleanup_failed', { error: error.message });
    }
  }

  /**
   * Initialize the storage provider
   * Creates the base uploads directory if it doesn't exist
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      await this.ensureDirectory(this.absoluteBasePath);
      logInfo('storage_initialized', {
        provider: this.name,
        basePath: this.absoluteBasePath
      });
    } catch (error) {
      logError('storage_initialization_failed', {
        provider: this.name,
        basePath: this.absoluteBasePath,
        error: error.message
      });
      throw new Error(`Failed to initialize storage: ${error.message}`);
    }
  }
}

module.exports = LocalStorageProvider;
