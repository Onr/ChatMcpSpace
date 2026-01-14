/**
 * Error Handling Utilities
 * Provides consistent error response formatting and error codes
 */

/**
 * Standard error codes used across the application
 */
const ErrorCodes = {
  // Authentication errors (401)
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_INVALID_API_KEY: 'AUTH_INVALID_API_KEY',
  AUTH_MISSING_CREDENTIALS: 'AUTH_MISSING_CREDENTIALS',
  
  // Authorization errors (403)
  FORBIDDEN_RESOURCE: 'FORBIDDEN_RESOURCE',
  
  // Validation errors (400)
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DUPLICATE_EMAIL: 'DUPLICATE_EMAIL',
  INVALID_OPTION_SELECTION: 'INVALID_OPTION_SELECTION',
  INVALID_TIMESTAMP: 'INVALID_TIMESTAMP',
  
  // Conflict errors (409)
  DUPLICATE_RESPONSE: 'DUPLICATE_RESPONSE',
  
  // Not found errors (404)
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  QUESTION_NOT_FOUND: 'QUESTION_NOT_FOUND',
  
  // Database errors (500)
  DATABASE_ERROR: 'DATABASE_ERROR',
  
  // Server errors (500)
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

/**
 * Create a standardized error response object
 * @param {string} code - Error code from ErrorCodes
 * @param {string} message - Human-readable error message
 * @param {*} details - Optional additional error details
 * @returns {Object} Formatted error response
 */
function createErrorResponse(code, message, details = null) {
  const response = {
    error: {
      code,
      message
    }
  };
  
  if (details) {
    response.error.details = details;
  }
  
  return response;
}

/**
 * Send an error response with appropriate HTTP status code
 * @param {Object} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {string} code - Error code from ErrorCodes
 * @param {string} message - Human-readable error message
 * @param {*} details - Optional additional error details
 */
function sendError(res, statusCode, code, message, details = null) {
  res.status(statusCode).json(createErrorResponse(code, message, details));
}

/**
 * Handle database errors and send appropriate response
 * @param {Object} res - Express response object
 * @param {Error} error - Database error object
 * @param {string} operation - Description of the operation that failed
 */
function handleDatabaseError(res, error, operation = 'database operation') {
  console.error(`Database error during ${operation}:`, error);
  
  // Handle specific PostgreSQL error codes
  switch (error.code) {
    case '23505': // Unique constraint violation
      if (error.constraint === 'users_email_key') {
        return sendError(res, 409, ErrorCodes.DUPLICATE_EMAIL, 'This email is already registered');
      }
      if (error.constraint === 'user_responses_message_id_key') {
        return sendError(res, 409, ErrorCodes.DUPLICATE_RESPONSE, 'You have already responded to this question');
      }
      return sendError(res, 409, ErrorCodes.DATABASE_ERROR, 'Duplicate entry detected');
      
    case '23503': // Foreign key violation
      return sendError(res, 400, ErrorCodes.VALIDATION_ERROR, 'Invalid reference: related record not found');
      
    case '23502': // Not null violation
      return sendError(res, 400, ErrorCodes.VALIDATION_ERROR, 'Required field is missing');
      
    case '22001': // String data too long
      return sendError(res, 400, ErrorCodes.VALIDATION_ERROR, 'Input exceeds maximum length');
      
    case '22P02': // Invalid text representation
      return sendError(res, 400, ErrorCodes.VALIDATION_ERROR, 'Invalid data format');
      
    default:
      return sendError(res, 500, ErrorCodes.DATABASE_ERROR, `Failed to complete ${operation}`);
  }
}

/**
 * Validation error helper
 * @param {Object} res - Express response object
 * @param {string} message - Validation error message
 */
function validationError(res, message) {
  sendError(res, 400, ErrorCodes.VALIDATION_ERROR, message);
}

/**
 * Authentication error helper
 * @param {Object} res - Express response object
 * @param {string} message - Authentication error message
 */
function authError(res, message = 'Authentication failed') {
  sendError(res, 401, ErrorCodes.AUTH_INVALID_CREDENTIALS, message);
}

/**
 * Authorization error helper
 * @param {Object} res - Express response object
 * @param {string} message - Authorization error message
 */
function forbiddenError(res, message = 'You do not have access to this resource') {
  sendError(res, 403, ErrorCodes.FORBIDDEN_RESOURCE, message);
}

/**
 * Not found error helper
 * @param {Object} res - Express response object
 * @param {string} resource - Name of the resource that was not found
 */
function notFoundError(res, resource = 'Resource') {
  const code = `${resource.toUpperCase()}_NOT_FOUND`;
  sendError(res, 404, ErrorCodes[code] || ErrorCodes.MESSAGE_NOT_FOUND, `${resource} not found`);
}

/**
 * Internal server error helper
 * @param {Object} res - Express response object
 * @param {string} message - Error message
 */
function internalError(res, message = 'An internal server error occurred') {
  sendError(res, 500, ErrorCodes.INTERNAL_ERROR, message);
}

module.exports = {
  ErrorCodes,
  createErrorResponse,
  sendError,
  handleDatabaseError,
  validationError,
  authError,
  forbiddenError,
  notFoundError,
  internalError
};
