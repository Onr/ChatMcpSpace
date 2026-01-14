/**
 * Authentication Service
 * Handles user registration, login, password hashing, and API key generation
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { query } = require('../db/connection');
const { generateEncryptionSalt } = require('../utils/encryptionHelper');

const SALT_ROUNDS = 10;

/**
 * Hash a password using bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Hashed password
 */
async function hashPassword(password) {
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    return hash;
  } catch (error) {
    console.error('Error hashing password:', error);
    throw new Error('Failed to hash password');
  }
}

/**
 * Generate a unique API key
 * @returns {string} Unique API key (UUID format)
 */
function generateApiKey() {
  return crypto.randomUUID();
}

/**
 * Generate a cryptographically secure script token
 * Used for short URL access to CLI scripts
 * @returns {string} 64-character hex string (32 bytes of randomness)
 */
function generateScriptToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Register a new user
 * @param {string} email - User email
 * @param {string} password - Plain text password
 * @returns {Promise<Object>} Created user object with userId, email, and apiKey
 * @throws {Error} If email already exists or registration fails
 */
async function registerUser(email, password) {
  try {
    // Hash the password
    const passwordHash = await hashPassword(password);
    
    // Generate unique API key
    const apiKey = generateApiKey();
    
    // Generate encryption salt for E2E encryption
    const encryptionSalt = generateEncryptionSalt();
    
    // Generate script token for short URL access
    const scriptToken = generateScriptToken();
    
    // Insert new user into database
    const result = await query(
      `INSERT INTO users (email, password_hash, api_key, encryption_salt, script_token)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, email, api_key, encryption_salt, script_token, created_at`,
      [email, passwordHash, apiKey, encryptionSalt, scriptToken]
    );
    
    if (result.rows.length === 0) {
      const error = new Error('Failed to create user');
      console.error('Registration failed: No rows returned from insert');
      throw error;
    }
    
    const user = result.rows[0];
    
    return {
      userId: user.user_id,
      email: user.email,
      apiKey: user.api_key,
      encryptionSalt: user.encryption_salt,
      scriptToken: user.script_token,
      createdAt: user.created_at
    };
  } catch (error) {
    // Check for unique constraint violation (duplicate email)
    if (error.code === '23505' && error.constraint === 'users_email_key') {
      console.error('Registration failed: Email already exists -', email);
      throw new Error('Email already registered');
    }
    
    // Check for other database constraint violations
    if (error.code === '23502') {
      console.error('Registration failed: Required field missing');
      throw new Error('Required field is missing');
    }
    
    console.error('Error registering user:', error);
    throw error;
  }
}

/**
 * Validate user credentials and return user data
 * @param {string} email - User email
 * @param {string} password - Plain text password
 * @returns {Promise<Object|null>} User object if valid, null if invalid, or object with emailNotVerified flag
 */
async function validateCredentials(email, password) {
  try {
    // Look up user by email (include email_verified field)
    const result = await query(
      'SELECT user_id, email, password_hash, api_key, encryption_salt, email_verified FROM users WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      console.error('Login failed: User not found -', email);
      return null; // User not found
    }
    
    const user = result.rows[0];
    
    // Compare password with hash
    const isValid = await bcrypt.compare(password, user.password_hash);
    
    if (!isValid) {
      console.error('Login failed: Invalid password for user -', email);
      return null; // Invalid password
    }
    
    // Check if email is verified
    if (!user.email_verified) {
      console.error('Login failed: Email not verified for user -', email);
      return {
        emailNotVerified: true,
        email: user.email,
        userId: user.user_id
      };
    }
    
    // Return user data (without password hash)
    return {
      userId: user.user_id,
      email: user.email,
      apiKey: user.api_key,
      encryptionSalt: user.encryption_salt
    };
  } catch (error) {
    console.error('Error validating credentials for user', email, ':', error);
    throw error;
  }
}

/**
 * Look up user by API key
 * @param {string} apiKey - API key to look up
 * @returns {Promise<Object|null>} User object if found, null otherwise
 */
async function getUserByApiKey(apiKey) {
  try {
    const result = await query(
      'SELECT user_id, email, api_key, encryption_salt FROM users WHERE api_key = $1',
      [apiKey]
    );
    
    if (result.rows.length === 0) {
      console.error('API key authentication failed: Invalid API key');
      return null;
    }
    
    const user = result.rows[0];
    
    return {
      userId: user.user_id,
      email: user.email,
      apiKey: user.api_key,
      encryptionSalt: user.encryption_salt
    };
  } catch (error) {
    console.error('Error looking up user by API key:', error);
    throw error;
  }
}

/**
 * Regenerate API key for a user
 * @param {string} userId - User ID
 * @returns {Promise<string>} New API key
 */
async function regenerateApiKey(userId) {
  try {
    const newApiKey = generateApiKey();
    
    const result = await query(
      `UPDATE users 
       SET api_key = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = $2 
       RETURNING api_key`,
      [newApiKey, userId]
    );
    
    if (result.rows.length === 0) {
      console.error('API key regeneration failed: User not found -', userId);
      throw new Error('User not found');
    }
    
    console.log('API key regenerated successfully for user:', userId);
    return result.rows[0].api_key;
  } catch (error) {
    console.error('Error regenerating API key for user', userId, ':', error);
    throw error;
  }
}

/**
 * Look up user by script token (for short URL script downloads)
 * @param {string} scriptToken - Script token to look up
 * @returns {Promise<Object|null>} User object if found, null otherwise
 */
async function getUserByScriptToken(scriptToken) {
  try {
    // Validate token format (must be 64 hex characters)
    if (!scriptToken || !/^[a-f0-9]{64}$/i.test(scriptToken)) {
      return null;
    }
    
    const result = await query(
      'SELECT user_id, email, api_key, encryption_salt, script_token FROM users WHERE script_token = $1',
      [scriptToken]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const user = result.rows[0];
    
    return {
      userId: user.user_id,
      email: user.email,
      apiKey: user.api_key,
      encryptionSalt: user.encryption_salt,
      scriptToken: user.script_token
    };
  } catch (error) {
    console.error('Error looking up user by script token:', error);
    throw error;
  }
}

/**
 * Regenerate script token for a user
 * @param {string} userId - User ID
 * @returns {Promise<string>} New script token
 */
async function regenerateScriptToken(userId) {
  try {
    const newScriptToken = generateScriptToken();
    
    const result = await query(
      `UPDATE users 
       SET script_token = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = $2 
       RETURNING script_token`,
      [newScriptToken, userId]
    );
    
    if (result.rows.length === 0) {
      console.error('Script token regeneration failed: User not found -', userId);
      throw new Error('User not found');
    }
    
    console.log('Script token regenerated successfully for user:', userId);
    return result.rows[0].script_token;
  } catch (error) {
    console.error('Error regenerating script token for user', userId, ':', error);
    throw error;
  }
}

/**
 * Create/initialize an express session for a user
 * @param {Object} req - Express request object with session
 * @param {Object} user - User object with userId and email
 * @returns {Promise<void>}
 */
async function createSession(req, user) {
  return new Promise((resolve, reject) => {
    try {
      // Set session data
      req.session.userId = user.userId;
      req.session.email = user.email;
      
      // Save the session
      req.session.save((err) => {
        if (err) {
          console.error('Error saving session:', err);
          reject(new Error('Failed to create session'));
        } else {
          resolve();
        }
      });
    } catch (error) {
      console.error('Error creating session:', error);
      reject(error);
    }
  });
}

/**
 * Destroy a user session
 * @param {Object} req - Express request object with session
 * @returns {Promise<void>}
 */
async function destroySession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session) {
      resolve();
      return;
    }
    
    req.session.destroy((err) => {
      if (err) {
        console.error('Error destroying session:', err);
        reject(new Error('Failed to destroy session'));
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  hashPassword,
  generateApiKey,
  generateScriptToken,
  registerUser,
  validateCredentials,
  getUserByApiKey,
  getUserByScriptToken,
  regenerateApiKey,
  regenerateScriptToken,
  createSession,
  destroySession
};
