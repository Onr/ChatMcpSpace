# Utility Modules

This directory contains utility modules for error handling and input validation.

## errorHandler.js

Provides consistent error response formatting and error handling utilities.

### Features:
- Standardized error codes (AUTH_INVALID_CREDENTIALS, VALIDATION_ERROR, etc.)
- Consistent error response format
- Database error handling with PostgreSQL error code mapping
- Helper functions for common error types (validation, auth, forbidden, etc.)

### Usage:
```javascript
const { validationError, handleDatabaseError } = require('../utils/errorHandler');

// Validation error
if (!isValid) {
  return validationError(res, 'Invalid input');
}

// Database error handling
try {
  await query(...);
} catch (error) {
  return handleDatabaseError(res, error, 'operation description');
}
```

## validation.js

Provides comprehensive input validation functions.

### Features:
- Email format validation
- Password strength validation (min 8 chars, letter + number required)
- Message content validation (max 10,000 chars)
- Priority value validation (low, normal, high)
- Options array validation for interactive questions
- ISO 8601 timestamp validation
- UUID format validation
- Agent name validation
- Boolean value validation

### Usage:
```javascript
const { isValidEmail, validatePasswordStrength, validateMessageContent } = require('../utils/validation');

// Email validation
if (!isValidEmail(email)) {
  return res.status(400).json({ error: 'Invalid email' });
}

// Password validation
const passwordValidation = validatePasswordStrength(password);
if (!passwordValidation.valid) {
  return res.status(400).json({ error: passwordValidation.message });
}

// Message content validation
const contentValidation = validateMessageContent(content);
if (!contentValidation.valid) {
  return validationError(res, contentValidation.message);
}
```

## Integration

Both utilities are integrated throughout the application:
- **pageRoutes.js**: Email and password validation for registration/login
- **agentApiRoutes.js**: Message content, priority, options array validation
- **userApiRoutes.js**: UUID and timestamp validation
- **authService.js**: Enhanced error logging for authentication operations
- **db/connection.js**: Enhanced query error logging

All routes now use consistent error handling with proper HTTP status codes and error messages.
