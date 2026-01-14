/**
 * Global Error Handling Middleware
 * Catches and handles errors that occur during request processing
 */

const { ErrorCodes, createErrorResponse } = require('../utils/errorHandler');
const { logError, logWarn } = require('../utils/logger');

/**
 * Global error handler middleware
 * Should be added as the last middleware in the Express app
 * 
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function globalErrorHandler(err, req, res, next) {
  // Log the error
  logError('unhandled_error', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userId: req.user?.userId || req.session?.userId || null,
  });
  
  // If headers already sent, delegate to default Express error handler
  if (res.headersSent) {
    return next(err);
  }
  
  // Determine status code + error code
  let statusCode = err.statusCode || err.status || null;
  let errorCode = err.code || ErrorCodes.INTERNAL_ERROR;

  // Map common error types to error codes + default status codes
  if (err.name === 'ValidationError') {
    errorCode = ErrorCodes.VALIDATION_ERROR;
    statusCode = statusCode || 400;
  } else if (err.name === 'UnauthorizedError') {
    errorCode = ErrorCodes.AUTH_INVALID_CREDENTIALS;
    statusCode = statusCode || 401;
  } else if (err.name === 'ForbiddenError') {
    errorCode = ErrorCodes.FORBIDDEN_RESOURCE;
    statusCode = statusCode || 403;
  }

  statusCode = statusCode || 500;
  
  // Create error message
  const message = err.message || 'An unexpected error occurred';
  
  // Send error response
  res.status(statusCode).json(createErrorResponse(errorCode, message));
}

/**
 * 404 Not Found handler
 * Should be added before the global error handler
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
function notFoundHandler(req, res) {
  logWarn('not_found', { method: req.method, url: req.url });
  
  // Check if it's an API request
  if (req.url.startsWith('/api/')) {
    return res.status(404).json(createErrorResponse(
      'ENDPOINT_NOT_FOUND',
      `API endpoint not found: ${req.method} ${req.url}`
    ));
  }
  
  // For page requests, render 404 page or redirect
  res.status(404).render('error', {
    error: 'Page not found',
    statusCode: 404
  });
}

/**
 * Async route handler wrapper
 * Wraps async route handlers to catch errors and pass them to error middleware
 * 
 * @param {Function} fn - Async route handler function
 * @returns {Function} Wrapped route handler
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Database error logger
 * Logs database errors with additional context
 * 
 * @param {Error} error - Database error
 * @param {string} operation - Description of the operation
 * @param {Object} context - Additional context (query, params, etc.)
 */
function logDatabaseError(error, operation, context = {}) {
  console.error('Database error:', {
    operation,
    errorCode: error.code,
    errorMessage: error.message,
    detail: error.detail,
    constraint: error.constraint,
    table: error.table,
    column: error.column,
    ...context
  });
}

module.exports = {
  globalErrorHandler,
  notFoundHandler,
  asyncHandler,
  logDatabaseError
};
