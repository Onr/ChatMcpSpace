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
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      userId: req.user?.userId || req.session?.userId || null,
      ip: req.ip,
      contentLength: res.getHeader('content-length') || null,
    });
  });

  next();
}

module.exports = {
  requestLogger,
};
