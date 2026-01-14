/**
 * Storage Provider Interface/Base Class
 * Defines the contract for storage providers that handle encrypted image attachments
 *
 * Storage providers store only encrypted ciphertext bytes and never decrypt them.
 * This abstraction allows pluggable storage backends (local disk, S3, etc.)
 */

/**
 * @typedef {Object} StorageMetadata
 * @property {string} attachmentId - Unique identifier for the attachment
 * @property {string} userId - ID of the user who owns the attachment
 * @property {string} agentId - ID of the agent associated with the attachment
 * @property {number} size - Size of the stored data in bytes
 * @property {Date} storedAt - Timestamp when the data was stored
 */

/**
 * Abstract base class for storage providers
 * Implementations must override all methods
 */
class StorageProvider {
  /**
   * Create a new StorageProvider instance
   * @param {Object} config - Provider-specific configuration
   */
  constructor(config = {}) {
    if (new.target === StorageProvider) {
      throw new Error('StorageProvider is an abstract class and cannot be instantiated directly');
    }
    this.config = config;
  }

  /**
   * Get the name of this storage provider
   * @returns {string} Provider name (e.g., 'local', 's3')
   */
  get name() {
    throw new Error('Subclass must implement name getter');
  }

  /**
   * Store encrypted data
   * @param {Buffer} buffer - Encrypted data to store (ciphertext bytes)
   * @param {string} attachmentId - Unique identifier for the attachment
   * @param {string} userId - ID of the user who owns the attachment
   * @param {string} agentId - ID of the agent associated with the attachment
   * @returns {Promise<string>} Storage key that can be used to retrieve the data
   * @throws {Error} If storage fails (disk full, permission denied, etc.)
   */
  async store(buffer, attachmentId, userId, agentId) {
    throw new Error('Subclass must implement store()');
  }

  /**
   * Retrieve encrypted data
   * @param {string} storageKey - Key returned from store()
   * @returns {Promise<Buffer>} The stored encrypted data (ciphertext bytes)
   * @throws {Error} If retrieval fails or data not found
   */
  async retrieve(storageKey) {
    throw new Error('Subclass must implement retrieve()');
  }

  /**
   * Delete stored data
   * @param {string} storageKey - Key returned from store()
   * @returns {Promise<void>}
   * @throws {Error} If deletion fails
   */
  async delete(storageKey) {
    throw new Error('Subclass must implement delete()');
  }

  /**
   * Check if data exists at the given storage key
   * @param {string} storageKey - Key returned from store()
   * @returns {Promise<boolean>} True if data exists, false otherwise
   */
  async exists(storageKey) {
    throw new Error('Subclass must implement exists()');
  }

  /**
   * Validate that required parameters are present and valid
   * @param {Buffer} buffer - Data buffer to validate
   * @param {string} attachmentId - Attachment ID to validate
   * @param {string} userId - User ID to validate
   * @param {string} agentId - Agent ID to validate
   * @throws {Error} If any parameter is invalid
   * @protected
   */
  validateStoreParams(buffer, attachmentId, userId, agentId) {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('Data must be a Buffer');
    }
    if (buffer.length === 0) {
      throw new Error('Data buffer cannot be empty');
    }
    if (!attachmentId || typeof attachmentId !== 'string') {
      throw new Error('attachmentId must be a non-empty string');
    }
    if (!userId || typeof userId !== 'string') {
      throw new Error('userId must be a non-empty string');
    }
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId must be a non-empty string');
    }
  }

  /**
   * Validate a storage key
   * @param {string} storageKey - Storage key to validate
   * @throws {Error} If storage key is invalid
   * @protected
   */
  validateStorageKey(storageKey) {
    if (!storageKey || typeof storageKey !== 'string') {
      throw new Error('storageKey must be a non-empty string');
    }
  }
}

module.exports = StorageProvider;
