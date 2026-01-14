/**
 * Storage Module
 * Factory and exports for the pluggable storage system
 *
 * This module provides a centralized way to access storage providers
 * for encrypted image attachments. Currently supports local disk storage,
 * with the architecture designed for easy addition of S3 or other providers.
 *
 * Usage:
 *   const { getStorageProvider } = require('./storage');
 *   const storage = getStorageProvider();
 *   const key = await storage.store(buffer, attachmentId, userId, agentId);
 *   const data = await storage.retrieve(key);
 */

const StorageProvider = require('./StorageProvider');
const LocalStorageProvider = require('./LocalStorageProvider');
const { logInfo, logError } = require('../utils/logger');

/**
 * Supported storage provider types
 * @enum {string}
 */
const StorageType = {
  LOCAL: 'local',
  // Future: S3: 's3'
};

/**
 * Default storage configuration
 */
const DEFAULT_CONFIG = {
  type: StorageType.LOCAL,
  local: {
    basePath: './uploads'
  }
  // Future: s3: { bucket: '', region: '', ... }
};

/**
 * Singleton instance of the storage provider
 * @type {StorageProvider|null}
 */
let storageInstance = null;

/**
 * Configuration for the storage provider
 * @type {Object|null}
 */
let currentConfig = null;

/**
 * Storage Factory
 * Creates and manages storage provider instances
 */
class StorageFactory {
  /**
   * Create a storage provider based on configuration
   * @param {Object} config - Storage configuration
   * @param {string} config.type - Provider type ('local', future: 's3')
   * @param {Object} [config.local] - Local provider configuration
   * @param {string} [config.local.basePath] - Base path for local storage
   * @returns {StorageProvider} Configured storage provider
   * @throws {Error} If provider type is not supported
   */
  static createProvider(config = {}) {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    const providerType = mergedConfig.type || StorageType.LOCAL;

    switch (providerType) {
      case StorageType.LOCAL: {
        const localConfig = mergedConfig.local || {};
        return new LocalStorageProvider(localConfig);
      }

      // Future: Add S3 provider here
      // case StorageType.S3: {
      //   const S3StorageProvider = require('./S3StorageProvider');
      //   return new S3StorageProvider(mergedConfig.s3);
      // }

      default:
        throw new Error(`Unsupported storage provider type: ${providerType}`);
    }
  }

  /**
   * Get the list of supported storage types
   * @returns {string[]} Array of supported type names
   */
  static getSupportedTypes() {
    return Object.values(StorageType);
  }
}

/**
 * Get or create the storage provider singleton
 * @param {Object} [config] - Optional configuration (only used on first call or after reset)
 * @returns {StorageProvider} The storage provider instance
 */
function getStorageProvider(config = null) {
  if (!storageInstance || (config && config !== currentConfig)) {
    const effectiveConfig = config || getConfigFromEnvironment();
    storageInstance = StorageFactory.createProvider(effectiveConfig);
    currentConfig = effectiveConfig;

    logInfo('storage_provider_created', {
      type: storageInstance.name
    });
  }

  return storageInstance;
}

/**
 * Get storage configuration from environment variables
 * @returns {Object} Configuration object
 */
function getConfigFromEnvironment() {
  const config = {
    type: process.env.STORAGE_TYPE || StorageType.LOCAL,
    local: {
      basePath: process.env.STORAGE_LOCAL_PATH || './uploads'
    }
  };

  // Future: Add S3 config from environment
  // if (process.env.STORAGE_S3_BUCKET) {
  //   config.s3 = {
  //     bucket: process.env.STORAGE_S3_BUCKET,
  //     region: process.env.STORAGE_S3_REGION || 'us-east-1',
  //     ...
  //   };
  // }

  return config;
}

/**
 * Initialize the storage system
 * Creates necessary directories and validates configuration
 * @param {Object} [config] - Optional configuration override
 * @returns {Promise<StorageProvider>} Initialized storage provider
 */
async function initializeStorage(config = null) {
  const provider = getStorageProvider(config);

  if (typeof provider.initialize === 'function') {
    await provider.initialize();
  }

  logInfo('storage_system_initialized', {
    type: provider.name
  });

  return provider;
}

/**
 * Reset the storage provider singleton
 * Useful for testing or configuration changes
 */
function resetStorageProvider() {
  storageInstance = null;
  currentConfig = null;

  logInfo('storage_provider_reset');
}

module.exports = {
  // Factory
  StorageFactory,

  // Singleton access
  getStorageProvider,
  initializeStorage,
  resetStorageProvider,

  // Types and classes
  StorageType,
  StorageProvider,
  LocalStorageProvider,

  // Configuration helpers
  getConfigFromEnvironment,
  DEFAULT_CONFIG
};
