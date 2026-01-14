/**
 * CSRF Protection Middleware
 * Implements CSRF token generation and validation for forms
 */

const crypto = require('crypto');
const { logCsrfViolation } = require('../utils/securityLogger');

const DEFAULT_CSRF_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CSRF_TOKEN_TTL_MS = (() => {
  const raw = Number.parseInt(process.env.CSRF_TOKEN_TTL_MS, 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_CSRF_TOKEN_TTL_MS;
})();

function parseCookieHeader(cookieHeader) {
  if (!cookieHeader) return {};
  const cookies = {};

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValueParts] = part.trim().split('=');
    if (!rawName) continue;
    const rawValue = rawValueParts.join('=');
    cookies[rawName] = decodeURIComponent(rawValue || '');
  }

  return cookies;
}

function getTokenIssuedAtMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return null;
}

function isTokenExpired(issuedAtMs) {
  if (!issuedAtMs) return false;
  return Date.now() - issuedAtMs > CSRF_TOKEN_TTL_MS;
}

/**
 * Generate a random CSRF token
 * @returns {string} CSRF token
 */
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Middleware to generate and attach CSRF token to session and response locals
 * Should be used before rendering forms
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function csrfProtection(req, res, next) {
  // Generate CSRF token if not already in session
  const issuedAtMs = getTokenIssuedAtMs(req.session.csrfTokenIssuedAt);
  if (!req.session.csrfToken || isTokenExpired(issuedAtMs)) {
    req.session.csrfToken = generateCsrfToken();
    req.session.csrfTokenIssuedAt = Date.now();
  } else if (!issuedAtMs) {
    // Backwards compatible: ensure old sessions receive an issuance timestamp.
    req.session.csrfTokenIssuedAt = Date.now();
  }
  
  // Make CSRF token available to templates
  res.locals.csrfToken = req.session.csrfToken;

  // Support double-submit cookie pattern in addition to session storage.
  const cookieOptions = {
    sameSite: 'lax',
    secure: req.secure,
    httpOnly: false,
    path: '/',
  };
  res.cookie('csrfToken', req.session.csrfToken, cookieOptions);
  res.cookie('csrfTokenIssuedAt', String(req.session.csrfTokenIssuedAt), cookieOptions);
  
  next();
}

/**
 * Middleware to validate CSRF token on POST requests
 * Should be used on routes that handle form submissions
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function validateCsrfToken(req, res, next) {
  // Skip CSRF validation for API routes (they use API key authentication)
  if (req.path.startsWith('/api/')) {
    return next();
  }
  
  // Only validate on state-changing methods
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const tokenFromBody = req.body._csrf || req.body.csrfToken;
    const tokenFromHeader = req.headers['x-csrf-token'];
    const tokenFromSession = req.session.csrfToken;
    const issuedAtFromSession = getTokenIssuedAtMs(req.session.csrfTokenIssuedAt);

    const cookies = parseCookieHeader(req.headers.cookie);
    const tokenFromCookie = cookies.csrfToken;
    const issuedAtFromCookie = getTokenIssuedAtMs(cookies.csrfTokenIssuedAt);
    
    const submittedToken = tokenFromBody || tokenFromHeader;
    
    // Check if token exists
    if (!submittedToken) {
      logCsrfViolation(req, 'CSRF token missing in request');
      return res.status(403).json({
        error: {
          code: 'CSRF_TOKEN_MISSING',
          message: 'CSRF token is required'
        }
      });
    }
    
    const matchesSession = tokenFromSession && submittedToken === tokenFromSession;
    const matchesCookie = tokenFromCookie && submittedToken === tokenFromCookie;

    // Validate token matches session token (or cookie token for double-submit pattern)
    if (!matchesSession && !matchesCookie) {
      logCsrfViolation(req, 'CSRF token mismatch');
      return res.status(403).json({
        error: {
          code: 'CSRF_TOKEN_INVALID',
          message: 'Invalid CSRF token'
        }
      });
    }

    const issuedAt = matchesSession ? issuedAtFromSession : issuedAtFromCookie;
    if (isTokenExpired(issuedAt)) {
      logCsrfViolation(req, 'CSRF token expired');
      return res.status(403).json({
        error: {
          code: 'CSRF_TOKEN_EXPIRED',
          message: 'CSRF token has expired'
        }
      });
    }
  }
  
  next();
}

/**
 * Combined middleware for CSRF protection
 * Generates token and validates on POST requests
 */
function csrf(req, res, next) {
  csrfProtection(req, res, () => {
    validateCsrfToken(req, res, next);
  });
}

module.exports = {
  generateCsrfToken,
  csrfProtection,
  validateCsrfToken,
  csrf
};
