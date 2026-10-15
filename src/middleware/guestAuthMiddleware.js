'use strict';

const crypto = require('crypto');
const guestService = require('../shared/guestService');
const { SharedError } = require('../shared/service');

const GUEST_SESSION_COOKIE = 'guest_sid';
const GUEST_CSRF_COOKIE = 'guest_csrf';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function guestSharingEnabled() {
  return process.env.FEATURE_SHARED_CONVERSATIONS === 'true'
    && process.env.FEATURE_GUEST_SHARING === 'true';
}

function parseCookieHeader(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch (_error) {
      cookies[name] = '';
    }
  }
  return cookies;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

function genericError(res, status = 401, code = 'GUEST_SESSION_UNAVAILABLE', message = 'Guest session unavailable') {
  return res.status(status).json({ error: { code, message } });
}

function noStore(res) {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  });
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.origin;
  } catch (_error) {
    return null;
  }
}

function requestOrigin(req) {
  return normalizeOrigin(`${req.protocol}://${req.get('host')}`);
}

function guestOriginAllowed(req, origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const configured = process.env.BASE_URL ? normalizeOrigin(process.env.BASE_URL) : null;
  return normalized === configured || normalized === requestOrigin(req);
}

function guestOriginCheck(req, res, next) {
  noStore(res);
  if (!MUTATING_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !guestOriginAllowed(req, origin)) {
    return res.status(403).json({
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Request origin is not permitted'
      }
    });
  }
  next();
}

function parseSessionCookie(value) {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf('.');
  if (separator < 1 || separator === value.length - 1) return null;
  const sessionId = value.slice(0, separator);
  const token = value.slice(separator + 1);
  if (!TOKEN_PATTERN.test(token)) return null;
  return { sessionId, token };
}

function sessionCookieValue(sessionId, token) {
  return `${sessionId}.${token}`;
}

function cookieOptions(req, maxAge) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || req.secure === true,
    sameSite: 'lax',
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge })
  };
}

function setGuestCookies(res, req, { sessionId, sessionToken, csrfToken, maxAge }) {
  res.cookie(GUEST_SESSION_COOKIE, sessionCookieValue(sessionId, sessionToken), cookieOptions(req, maxAge));
  res.cookie(GUEST_CSRF_COOKIE, csrfToken, {
    ...cookieOptions(req, maxAge),
    httpOnly: false
  });
}

function clearGuestCookies(res, req) {
  const options = cookieOptions(req);
  res.clearCookie(GUEST_SESSION_COOKIE, options);
  res.clearCookie(GUEST_CSRF_COOKIE, { ...options, httpOnly: false });
}

async function guestSessionRequired(req, res, next) {
  noStore(res);
  if (!guestSharingEnabled()) {
    return res.status(404).json({ error: { code: 'GUEST_SHARING_DISABLED', message: 'Guest sharing is not enabled' } });
  }

  const cookies = parseCookieHeader(req.headers.cookie);
  const parsed = parseSessionCookie(cookies[GUEST_SESSION_COOKIE]);
  if (!parsed) return genericError(res);

  try {
    const access = await guestService.currentGuestAccess({
      sessionId: parsed.sessionId,
      sessionTokenHash: tokenHash(parsed.token)
    });
    req.guestAccess = access;
    req.guestSessionId = parsed.sessionId;
    req.guestSessionTokenHash = tokenHash(parsed.token);
    next();
  } catch (error) {
    if (error instanceof SharedError) return genericError(res);
    next(error);
  }
}

function tokensEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function guestCsrfRequired(req, res, next) {
  noStore(res);
  if (!MUTATING_METHODS.has(req.method)) return next();
  const submitted = req.get('x-guest-csrf') || req.body?.csrfToken;
  const expectedHash = req.guestAccess?.session?.csrf_secret_hash;
  if (!TOKEN_PATTERN.test(String(submitted || '')) || !expectedHash
    || !tokensEqual(tokenHash(String(submitted)), expectedHash)) {
    return res.status(403).json({
      error: {
        code: 'GUEST_CSRF_INVALID',
        message: 'A valid guest CSRF token is required'
      }
    });
  }
  next();
}

module.exports = {
  GUEST_SESSION_COOKIE,
  GUEST_CSRF_COOKIE,
  guestSharingEnabled,
  parseCookieHeader,
  tokenHash,
  guestOriginCheck,
  guestSessionRequired,
  guestCsrfRequired,
  setGuestCookies,
  clearGuestCookies,
  sessionCookieValue,
  parseSessionCookie
};
