/**
 * Authentication Middleware
 * Provides middleware for session-based and API key authentication
 */

const crypto = require('crypto');
const { getUserByApiKey } = require('../services/authService');
const { verifyScopedCredential } = require('../services/agentCredentialService');
const { isEmailVerified } = require('../services/emailService');
const { logApiKeyUsage } = require('../utils/securityLogger');
const { query } = require('../db/connection');

const AGENT_SCOPE_RULES = [
  { method: 'GET', path: /^\/shared(?:\/.*)?$/, scope: 'agent.responses.read' },
  { method: 'POST', path: /^\/shared(?:\/.*)?$/, scope: 'agent.messages.write' },
  { method: 'PUT', path: /^\/shared\/identity$/, scope: 'agent.messages.write' },
  { method: 'POST', path: /^\/attachments$/, scope: 'agent.attachments.write' },
  { method: 'GET', path: /^\/attachments\/[^/]+$/, scope: 'agent.attachments.read' },
  { method: 'POST', path: /^\/messages$/, scope: 'agent.messages.write' },
  { method: 'POST', path: /^\/questions$/, scope: 'agent.questions.write' },
  { method: 'GET', path: /^\/responses$/, scope: 'agent.responses.read' },
  { method: 'GET', path: /^\/config$/, scope: 'agent.responses.read' },
  { method: 'POST', path: /^\/responses\/ack$/, scope: 'agent.responses.read' },
  { method: 'POST', path: /^\/heartbeat$/, scope: 'agent.responses.read' },
  { method: 'GET', path: /^\/discover$/, scope: 'agent.discover.read' },
  { method: 'POST', path: /^\/messages\/direct$/, scope: 'agent.dm.write' },
  { method: 'GET', path: /^\/messages\/direct$/, scope: 'agent.dm.read' },
  { method: 'POST', path: /^\/messages\/direct\/ack$/, scope: 'agent.dm.read' },
  { method: 'GET', path: /^\/groups$/, scope: 'agent.groups.read' },
  { method: 'POST', path: /^\/groups$/, scope: 'agent.groups.write' },
  { method: 'POST', path: /^\/groups\/.+\/join$/, scope: 'agent.groups.write' },
  { method: 'GET', path: /^\/groups\/.+\/salt$/, scope: 'agent.groups.read' },
  { method: 'POST', path: /^\/spawn$/, scope: 'agent.spawn.write' },
  { method: 'POST', path: /^\/stop\/acknowledge$/, scope: 'agent.stop.write' },
  { method: 'POST', path: /^\/stop$/, scope: 'agent.stop.write' },
  { method: 'POST', path: /^\/self-terminate$/, scope: 'agent.stop.write' },
  { method: 'GET', path: /^\/lineage$/, scope: 'agent.lineage.read' },
  { method: 'GET', path: /^\/children$/, scope: 'agent.lineage.read' },
  { method: 'GET', path: /^\/messages\/history$/, scope: 'agent.history.read' },
  { method: 'GET', path: /^\/messages\/latest$/, scope: 'agent.history.read' },
  { method: 'GET', path: /^\/usage-limits$/, scope: 'agent.usage.read' }
];

function hasScope(scopes, neededScope) {
  if (!Array.isArray(scopes)) return false;
  if (scopes.includes('*') || scopes.includes('agent.*')) return true;
  if (scopes.includes(neededScope)) return true;

  const [prefix] = neededScope.split('.');
  if (prefix && scopes.includes(`${prefix}.*`)) return true;

  return false;
}

function requiredScopeForRequest(req) {
  const method = (req.method || 'GET').toUpperCase();
  const path = req.path || '/';

  for (const rule of AGENT_SCOPE_RULES) {
    if (rule.method === method && rule.path.test(path)) {
      return rule.scope;
    }
  }

  return null;
}

async function logScopedAuthEvent({ agentId, credentialId, eventType, req, metadata = {} }) {
  try {
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
    const userAgent = req.headers['user-agent'] || '';
    const ipHash = ip ? crypto.createHash('sha256').update(ip).digest('hex') : null;
    const userAgentHash = userAgent ? crypto.createHash('sha256').update(userAgent).digest('hex') : null;

    await query(
      `INSERT INTO agent_auth_events
       (agent_id, credential_id, event_type, ip_hash, user_agent_hash, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [agentId, credentialId || null, eventType, ipHash, userAgentHash, JSON.stringify(metadata)]
    );
  } catch (_error) {
    // Best effort only; auth should not fail due to logging issues.
  }
}

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
    const agentToken = req.headers['x-agent-token'];
    const apiKey = req.headers['x-api-key'];

    // Prefer scoped agent token when provided
    if (agentToken) {
      const scopedAuth = await verifyScopedCredential(agentToken);
      if (!scopedAuth) {
        return res.status(401).json({
          error: {
            code: 'AUTH_INVALID_API_KEY',
            message: 'Invalid or expired agent token'
          }
        });
      }

      const requiredScope = requiredScopeForRequest(req);
      if (!requiredScope) {
        await logScopedAuthEvent({
          agentId: scopedAuth.agentId,
          credentialId: scopedAuth.credentialId,
          eventType: 'auth_scope_unmapped_route',
          req,
          metadata: { method: req.method, path: req.path }
        });

        return res.status(403).json({
          error: {
            code: 'FORBIDDEN_RESOURCE',
            message: 'Scoped agent token is not allowed for this endpoint'
          }
        });
      }

      if (!hasScope(scopedAuth.scopes, requiredScope)) {
        await logScopedAuthEvent({
          agentId: scopedAuth.agentId,
          credentialId: scopedAuth.credentialId,
          eventType: 'auth_scope_denied',
          req,
          metadata: { method: req.method, path: req.path, requiredScope }
        });

        return res.status(403).json({
          error: {
            code: 'FORBIDDEN_RESOURCE',
            message: `Agent token missing required scope: ${requiredScope}`
          }
        });
      }

      const requestedAgentName = req.headers['x-agent-name'];
      const requestedIdentities = [requestedAgentName, req.body?.agentName, req.query?.agentName]
        .filter(value => value !== undefined);
      if (requestedIdentities.some(value => typeof value !== 'string' || value.trim() !== scopedAuth.agentName)) {
        await logScopedAuthEvent({
          agentId: scopedAuth.agentId,
          credentialId: scopedAuth.credentialId,
          eventType: 'auth_agent_mismatch',
          req,
          metadata: {
            requestedAgentName: typeof requestedAgentName === 'string' ? requestedAgentName.trim() : null,
            boundAgentName: scopedAuth.agentName
          }
        });

        return res.status(403).json({
          error: {
            code: 'FORBIDDEN_RESOURCE',
            message: 'Scoped agent token can only be used for its bound agent identity'
          }
        });
      }

      if (!requestedAgentName) {
        req.headers['x-agent-name'] = scopedAuth.agentName;
      }

      // Responses without a filter must never return every agent's inbox when
      // the caller only owns one scoped identity.
      if (req.method === 'GET' && req.path === '/responses') {
        req.query.agentName = scopedAuth.agentName;
      }

      req.user = scopedAuth.user;
      req.authContext = {
        type: 'agent_token',
        agentId: scopedAuth.agentId,
        agentName: scopedAuth.agentName,
        credentialId: scopedAuth.credentialId,
        scopes: scopedAuth.scopes
      };

      await logScopedAuthEvent({
        agentId: scopedAuth.agentId,
        credentialId: scopedAuth.credentialId,
        eventType: 'auth_success',
        req,
        metadata: { method: req.method, path: req.path }
      });

      next();
      return;
    }

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
    req.authContext = { type: 'api_key' };
    
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
                         (req.headers['accept'] || '').includes('application/json') ||
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
