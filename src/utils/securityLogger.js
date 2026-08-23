/**
 * Security Logger
 * Logs security-related events for monitoring and auditing
 */

const crypto = require('crypto');

/**
 * Hash an IP address for privacy-preserving logging
 * @param {string} ip - Raw IP address
 * @returns {string} Hashed IP prefix (16 hex chars)
 */
function hashIp(ip) {
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex').substring(0, 16);
}

function hashEmail(email) {
  if (!email || typeof email !== 'string') {
    return 'unknown';
  }
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').substring(0, 16);
}

function shouldLogApiKeyUsage() {
  return String(process.env.SECURITY_LOG_API_KEY_USAGE || '').toLowerCase() === 'true';
}

const RATE_LIMIT_LOG_THROTTLE_MS = 30_000;
const RATE_LIMIT_LOG_STATE_LIMIT = 2_000;
const rateLimitLogState = new Map();

function shouldLogRateLimitViolation(key) {
  const now = Date.now();
  const previous = rateLimitLogState.get(key);

  if (previous && now - previous.lastLoggedAt < RATE_LIMIT_LOG_THROTTLE_MS) {
    previous.suppressed += 1;
    return { shouldLog: false, suppressed: previous.suppressed };
  }

  const suppressed = previous ? previous.suppressed : 0;
  rateLimitLogState.set(key, { lastLoggedAt: now, suppressed: 0 });

  if (rateLimitLogState.size > RATE_LIMIT_LOG_STATE_LIMIT) {
    const oldestKey = rateLimitLogState.keys().next().value;
    if (oldestKey) rateLimitLogState.delete(oldestKey);
  }

  return { shouldLog: true, suppressed };
}

/**
 * Log unauthorized access attempt
 * @param {Object} req - Express request object
 * @param {string} resourceType - Type of resource being accessed (e.g., 'agent', 'message', 'question')
 * @param {string} resourceId - ID of the resource
 * @param {string} reason - Reason for denial
 */
function logUnauthorizedAccess(req, resourceType, resourceId, reason) {
  const timestamp = new Date().toISOString();
  const userId = req.user ? req.user.userId : 'unknown';
  const emailHash = req.user ? hashEmail(req.user.email) : 'unknown';
  const rawIp = req.ip || req.connection.remoteAddress || 'unknown';
  const hashedIp = hashIp(rawIp);
  const userAgent = req.headers['user-agent'] || 'unknown';
  const path = req.path;
  const method = req.method;

  console.warn('[SECURITY] Unauthorized access attempt:', {
    timestamp,
    userId,
    emailHash,
    ip: hashedIp,
    userAgent,
    method,
    path,
    resourceType,
    resourceId,
    reason
  });

  // In production, this should also:
  // - Write to a dedicated security log file
  // - Send alerts for repeated attempts
  // - Store in a security events database
  // - Integrate with SIEM systems
}

/**
 * Log authentication failure
 * @param {Object} req - Express request object
 * @param {string} email - Email used in authentication attempt
 * @param {string} reason - Reason for failure
 */
function logAuthenticationFailure(req, email, reason) {
  const timestamp = new Date().toISOString();
  const rawIp = req.ip || req.connection.remoteAddress || 'unknown';
  const hashedIp = hashIp(rawIp);
  const userAgent = req.headers['user-agent'] || 'unknown';

  console.warn('[SECURITY] Authentication failure:', {
    timestamp,
    emailHash: hashEmail(email),
    ip: hashedIp,
    userAgent,
    reason
  });
}

/**
 * Log API key usage
 * @param {Object} req - Express request object
 * @param {string} userId - User ID associated with the API key
 * @param {string} action - Action being performed
 */
function logApiKeyUsage(req, userId, action) {
  if (!shouldLogApiKeyUsage()) {
    return;
  }

  const timestamp = new Date().toISOString();
  const rawIp = req.ip || req.connection.remoteAddress || 'unknown';
  const hashedIp = hashIp(rawIp);
  const path = req.path;
  const method = req.method;

  console.log('[API] API key usage:', {
    timestamp,
    userId,
    ip: hashedIp,
    method,
    path,
    action
  });
}

/**
 * Log rate limit violation
 * @param {Object} req - Express request object
 * @param {string} limitType - Type of rate limit (e.g., 'general', 'auth', 'polling')
 */
function logRateLimitViolation(req, limitType) {
  const timestamp = new Date().toISOString();
  const userId = req.user ? req.user.userId : 'unknown';
  const rawIp = req.ip || req.connection.remoteAddress || 'unknown';
  const hashedIp = hashIp(rawIp);
  const path = req.path;
  const throttleKey = `${limitType}|${userId}|${hashedIp}|${path}`;
  const throttle = shouldLogRateLimitViolation(throttleKey);

  if (!throttle.shouldLog) {
    return;
  }

  console.warn('[SECURITY] Rate limit exceeded:', {
    timestamp,
    userId,
    ip: hashedIp,
    path,
    limitType,
    ...(throttle.suppressed > 0 ? { suppressedSinceLastLog: throttle.suppressed } : {})
  });
}

/**
 * Log CSRF token violation
 * @param {Object} req - Express request object
 * @param {string} reason - Reason for CSRF failure
 */
function logCsrfViolation(req, reason) {
  const timestamp = new Date().toISOString();
  const userId = req.user ? req.user.userId : ((req.session && req.session.userId) || 'unknown');
  const rawIp = req.ip || req.connection.remoteAddress || 'unknown';
  const hashedIp = hashIp(rawIp);
  const path = req.path;
  const method = req.method;

  console.warn('[SECURITY] CSRF violation:', {
    timestamp,
    userId,
    ip: hashedIp,
    method,
    path,
    reason
  });
}

module.exports = {
  hashEmail,
  logUnauthorizedAccess,
  logAuthenticationFailure,
  logApiKeyUsage,
  logRateLimitViolation,
  logCsrfViolation
};
