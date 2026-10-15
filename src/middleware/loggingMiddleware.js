const { logInfo } = require('../utils/logger');

/**
 * Minimal structured access logging.
 * Logs method, path, status, duration, and a lightweight identifier (user/session/ip).
 */
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logInfo('http_request', {
      method: req.method,
      path: safeRequestPath(req),
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      userId: (req.user && req.user.userId) || (req.session && req.session.userId) || null,
      ip: req.ip,
      contentLength: res.getHeader('content-length') || null,
    });
  });

  next();
}

function safeRequestPath(req) {
  const raw = req.originalUrl || req.url || req.path || '/';
  const pathOnly = String(raw).split('?')[0];
  // OAuth authorization URLs carry state and PKCE challenges in the query.
  // Keep the useful endpoint path while ensuring credentials never reach logs.
  if (pathOnly.startsWith('/oauth/')) return pathOnly;
  return raw;
}

module.exports = {
  requestLogger,
  safeRequestPath,
};
