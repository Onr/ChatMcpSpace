/**
 * Security Logger
 * Logs security-related events for monitoring and auditing
 */

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
  const email = req.user ? req.user.email : 'unknown';
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  const path = req.path;
  const method = req.method;
  
  console.warn('[SECURITY] Unauthorized access attempt:', {
    timestamp,
    userId,
    email,
    ip,
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
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  
  console.warn('[SECURITY] Authentication failure:', {
    timestamp,
    email,
    ip,
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
  const timestamp = new Date().toISOString();
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const path = req.path;
  const method = req.method;
  
  console.log('[API] API key usage:', {
    timestamp,
    userId,
    ip,
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
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const path = req.path;
  
  console.warn('[SECURITY] Rate limit exceeded:', {
    timestamp,
    userId,
    ip,
    path,
    limitType
  });
}

/**
 * Log CSRF token violation
 * @param {Object} req - Express request object
 * @param {string} reason - Reason for CSRF failure
 */
function logCsrfViolation(req, reason) {
  const timestamp = new Date().toISOString();
  const userId = req.user ? req.user.userId : req.session?.userId || 'unknown';
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const path = req.path;
  const method = req.method;
  
  console.warn('[SECURITY] CSRF violation:', {
    timestamp,
    userId,
    ip,
    method,
    path,
    reason
  });
}

module.exports = {
  logUnauthorizedAccess,
  logAuthenticationFailure,
  logApiKeyUsage,
  logRateLimitViolation,
  logCsrfViolation
};
