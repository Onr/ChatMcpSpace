/**
 * Authentication Middleware
 * Provides middleware for session-based and API key authentication
 */

const { getUserByApiKey } = require('../services/authService');
const { isEmailVerified } = require('../services/emailService');
const { logApiKeyUsage } = require('../utils/securityLogger');
const { query } = require('../db/connection');

// Cache whether the email_verified column exists to avoid repeated failing queries.
let emailVerificationColumnAvailable = true;

async function fetchUserForSession(userId) {
  const baseSelect = 'SELECT user_id, email';
  const selectClause = emailVerificationColumnAvailable ? `${baseSelect}, email_verified` : baseSelect;
  const sql = `${selectClause} FROM users WHERE user_id = $1`;

  try {
    const result = await query(sql, [userId]);
    return { result, emailVerificationChecked: emailVerificationColumnAvailable };
  } catch (error) {
    // If the column is missing (older schema), fall back to without email_verified.
    if (emailVerificationColumnAvailable && error.code === '42703') {
      console.warn(
        'email_verified column not found; continuing without email verification until migration is applied.'
      );
      emailVerificationColumnAvailable = false;
      const fallbackResult = await query(`${baseSelect} FROM users WHERE user_id = $1`, [userId]);
      return { result: fallbackResult, emailVerificationChecked: false };
    }
    throw error;
  }
}

/**
 * Middleware to check for valid session on protected routes
 * Redirects to landing page if no valid session exists
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function requireSession(req, res, next) {
  if (req.session && req.session.userId) {
    // Valid session exists, proceed
    return next();
  }
  
  // No valid session, redirect to landing page
  res.redirect('/');
}

/**
 * Middleware to attach user data to request object from session
 * Also checks email verification status
 * Should be used after requireSession middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
async function attachUserFromSession(req, res, next) {
  if (req.session && req.session.userId) {
    try {
      // Get user data including email verification status
      const { result, emailVerificationChecked } = await fetchUserForSession(req.session.userId);

      if (result.rows.length === 0) {
        // User not found in database, clear session
        req.session.destroy();
        return res.status(401).json({
          error: {
            code: 'AUTH_USER_NOT_FOUND',
            message: 'User session is invalid'
          }
        });
      }

      const user = result.rows[0];

      // Attach user data to request
      req.user = {
        userId: user.user_id,
        email: user.email,
        emailVerified: emailVerificationChecked ? user.email_verified === true : false
      };

      // Also set for templates
      res.locals.emailVerified = req.user.emailVerified;

      return next();
    } catch (error) {
      console.error('Error fetching user from session:', error);
      return res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to validate session'
        }
      });
    }
  }
  
  // No session data
  return res.status(401).json({
    error: {
      code: 'AUTH_MISSING_CREDENTIALS',
      message: 'No valid session found'
    }
  });
}

/**
 * Middleware to validate X-API-Key header for agent endpoints
 * Looks up user by API key and attaches user data to request
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
async function requireApiKey(req, res, next) {
  try {
    // Get API key from header
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
      return res.status(401).json({
        error: {
          code: 'AUTH_MISSING_CREDENTIALS',
          message: 'API key is required. Include X-API-Key header in your request.'
        }
      });
    }
    
    // Look up user by API key
    const user = await getUserByApiKey(apiKey);
    
    if (!user) {
      return res.status(401).json({
        error: {
          code: 'AUTH_INVALID_API_KEY',
          message: 'Invalid API key'
        }
      });
    }
    
    // Attach user data to request
    req.user = user;
    
    // Log API key usage
    logApiKeyUsage(req, user.userId, 'API request authenticated');
    
    // Proceed to next middleware/route handler
    next();
  } catch (error) {
    console.error('Error in API key authentication:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Authentication failed'
      }
    });
  }
}

/**
 * Combined middleware for protected page routes
 * Checks session and attaches user data
 */
function protectRoute(req, res, next) {
  requireSession(req, res, () => {
    attachUserFromSession(req, res, next);
  });
}

/**
 * Middleware to require email verification for certain actions
 * Use after protectRoute to enforce email verification
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function requireEmailVerification(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Authentication required'
      }
    });
  }

  if (!req.user.emailVerified) {
    // Check if this is an API request or a page request
    const isApiRequest = req.path.startsWith('/api/') || 
                         req.headers['accept']?.includes('application/json') ||
                         req.xhr;

    if (isApiRequest) {
      return res.status(403).json({
        error: {
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Please verify your email address to use this feature'
        }
      });
    } else {
      return res.redirect('/verify-email-sent');
    }
  }

  next();
}

module.exports = {
  requireSession,
  attachUserFromSession,
  requireApiKey,
  protectRoute,
  requireEmailVerification
};
