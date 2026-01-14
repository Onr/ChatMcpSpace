/**
 * Encryption Helper for Agent-Side Message Encryption
 * Uses AES-256-GCM with password + user-specific salt
 * 
 * SECURITY MODEL:
 * - Each user has a unique encryption_salt (stored in DB)
 * - Encryption key = PBKDF2(user_password, encryption_salt)
 * - Server NEVER stores the encryption key
 * - Server CANNOT decrypt messages (true end-to-end encryption)
 * - Agent gets salt from API guide to derive key from password
 */

const crypto = require('crypto');

/**
 * Generate a random encryption salt for a new user
 * This should be called once during user registration
 * 
 * @returns {string} - Base64 encoded 32-byte salt
 */
function generateEncryptionSalt() {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Derive an encryption key from user password and salt
 * This is the core security function - same key derivation for agent and client
 * 
 * @param {string} password - The user's plaintext password
 * @param {string} encryptionSalt - The user's unique encryption salt (base64)
 * @returns {Buffer} - 32-byte encryption key
 */
function deriveEncryptionKey(password, encryptionSalt) {
  const saltBuffer = Buffer.from(encryptionSalt, 'base64');
  const iterations = 100000; // OWASP recommended minimum
  const keyLength = 32; // 256 bits for AES-256
  
  return crypto.pbkdf2Sync(password, saltBuffer, iterations, keyLength, 'sha256');
}

/**
 * Encrypt a message using AES-256-GCM
 * Agent calls this before sending messages to the server
 * 
 * @param {string} plaintext - The message content to encrypt
 * @param {string} password - The user's plaintext password
 * @param {string} encryptionSalt - The user's encryption salt (base64)
 * @returns {string} - Encrypted message in format: iv:authTag:ciphertext (base64)
 */
function encryptMessage(plaintext, password, encryptionSalt) {
  try {
    // Derive encryption key from password and salt
    const key = deriveEncryptionKey(password, encryptionSalt);
    
    // Generate random IV (initialization vector)
    const iv = crypto.randomBytes(12); // 12 bytes for GCM
    
    // Create cipher
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    // Encrypt the message
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    // Get authentication tag
    const authTag = cipher.getAuthTag();
    
    // Combine iv, authTag, and encrypted data
    // Format: iv:authTag:ciphertext (all base64 encoded)
    const result = `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
    
    return result;
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

/**
 * Decrypt a message using AES-256-GCM
 * Client (browser) calls this to decrypt messages after login
 * 
 * @param {string} encryptedData - Encrypted message in format: iv:authTag:ciphertext
 * @param {string} password - The user's plaintext password
 * @param {string} encryptionSalt - The user's encryption salt (base64)
 * @returns {string} - Decrypted plaintext message
 */
function decryptMessage(encryptedData, password, encryptionSalt) {
  try {
    // Parse the encrypted data
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }
    
    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const encrypted = parts[2];
    
    // Derive encryption key from password and salt
    const key = deriveEncryptionKey(password, encryptionSalt);
    
    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    // Decrypt the message
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

/**
 * Get encryption algorithm parameters for client-side implementation
 * Browser will use Web Crypto API with these same parameters
 * 
 * @returns {Object} - Algorithm parameters for client-side key derivation
 */
function getEncryptionParams() {
  return {
    algorithm: 'PBKDF2',
    hash: 'SHA-256',
    iterations: 100000,
    keyLength: 256,
    cipherAlgorithm: 'AES-GCM',
    ivLength: 12,
    tagLength: 128
  };
}

module.exports = {
  generateEncryptionSalt,
  deriveEncryptionKey,
  encryptMessage,
  decryptMessage,
  getEncryptionParams
};
