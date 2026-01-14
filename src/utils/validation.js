/**
 * Input Validation Utilities
 * Provides validation functions for user inputs
 */

/**
 * Validate email format
 * @param {string} email - Email address to validate
 * @returns {boolean} True if valid, false otherwise
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }

  // RFC 5322 compliant email regex (simplified)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate password strength
 * Requirements:
 * - At least 8 characters long
 * - Contains at least one letter
 * - Contains at least one number
 * 
 * @param {string} password - Password to validate
 * @returns {Object} { valid: boolean, message: string }
 */
function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    return {
      valid: false,
      message: 'Password is required'
    };
  }

  if (password.length < 8) {
    return {
      valid: false,
      message: 'Password must be at least 8 characters long'
    };
  }

  if (password.length > 128) {
    return {
      valid: false,
      message: 'Password must not exceed 128 characters'
    };
  }

  // Check for at least one letter
  if (!/[a-zA-Z]/.test(password)) {
    return {
      valid: false,
      message: 'Password must contain at least one letter'
    };
  }

  // Check for at least one number
  if (!/[0-9]/.test(password)) {
    return {
      valid: false,
      message: 'Password must contain at least one number'
    };
  }

  return {
    valid: true,
    message: 'Password is valid'
  };
}

/**
 * Validate message content length
 * @param {string} content - Message content to validate
 * @param {number|Object} maxLengthOrOptions - Maximum allowed length (default: 100000) or options object
 * @param {number} maxLengthOrOptions.maxLength - Maximum allowed length (default: 100000)
 * @param {boolean} maxLengthOrOptions.allowEmpty - Allow empty/null content (default: false)
 * @returns {Object} { valid: boolean, message: string }
 */
function validateMessageContent(content, maxLengthOrOptions = 100000) {
  // Handle both old signature (maxLength number) and new signature (options object)
  let maxLength = 100000;
  let allowEmpty = false;

  if (typeof maxLengthOrOptions === 'number') {
    maxLength = maxLengthOrOptions;
  } else if (typeof maxLengthOrOptions === 'object' && maxLengthOrOptions !== null) {
    maxLength = maxLengthOrOptions.maxLength || 100000;
    allowEmpty = maxLengthOrOptions.allowEmpty || false;
  }

  // Allow empty content if explicitly permitted (e.g., when attachments are present)
  if (allowEmpty) {
    if (content === null || content === undefined) {
      return {
        valid: true,
        message: 'Content is valid (empty allowed)'
      };
    }
    if (typeof content === 'string' && content.trim().length === 0) {
      return {
        valid: true,
        message: 'Content is valid (empty allowed)'
      };
    }
  }

  if (!content || typeof content !== 'string') {
    return {
      valid: false,
      message: 'Message content is required'
    };
  }

  if (content.trim().length === 0) {
    return {
      valid: false,
      message: 'Message content cannot be empty'
    };
  }

  if (content.length > maxLength) {
    return {
      valid: false,
      message: `Message content exceeds maximum length of ${maxLength} characters`
    };
  }

  return {
    valid: true,
    message: 'Content is valid'
  };
}

/**
 * Validate an array of attachment IDs
 * Validates that each ID is a valid UUID format
 * @param {string[]} attachmentIds - Array of attachment UUIDs
 * @returns {Object} { valid: boolean, message: string, ids: string[] }
 */
function validateAttachmentIds(attachmentIds) {
  // If not provided or not an array, return valid with empty array
  if (attachmentIds === undefined || attachmentIds === null) {
    return {
      valid: true,
      message: 'No attachments provided',
      ids: []
    };
  }

  if (!Array.isArray(attachmentIds)) {
    return {
      valid: false,
      message: 'attachmentIds must be an array',
      ids: []
    };
  }

  // Empty array is valid
  if (attachmentIds.length === 0) {
    return {
      valid: true,
      message: 'No attachments provided',
      ids: []
    };
  }

  // Validate maximum count
  if (attachmentIds.length > 10) {
    return {
      valid: false,
      message: 'Cannot attach more than 10 files to a single message',
      ids: []
    };
  }

  // Validate each ID is a valid UUID
  const validatedIds = [];
  for (let i = 0; i < attachmentIds.length; i++) {
    const id = attachmentIds[i];
    if (!isValidUUID(id)) {
      return {
        valid: false,
        message: `Invalid attachment ID format at index ${i}`,
        ids: []
      };
    }
    validatedIds.push(id);
  }

  // Check for duplicates
  const uniqueIds = new Set(validatedIds);
  if (uniqueIds.size !== validatedIds.length) {
    return {
      valid: false,
      message: 'Duplicate attachment IDs are not allowed',
      ids: []
    };
  }

  return {
    valid: true,
    message: 'Attachment IDs are valid',
    ids: validatedIds
  };
}

/**
 * Validate priority value
 * Priority is an integer: 0 = all ok, 1 = needs attention, 2 = urgent
 * @param {number} priority - Priority value to validate (0, 1, or 2)
 * @returns {Object} { valid: boolean, message: string, value: number, isUrgent: boolean }
 */
function validatePriority(priority) {
  const validPriorities = [0, 1, 2];

  // If no priority provided, use default (0 = all ok)
  if (priority === undefined || priority === null) {
    return {
      valid: true,
      message: 'Using default priority',
      value: 0,
      isUrgent: false
    };
  }

  // Convert string to number if needed
  const numPriority = typeof priority === 'string' ? parseInt(priority, 10) : priority;

  if (typeof numPriority !== 'number' || isNaN(numPriority)) {
    return {
      valid: false,
      message: 'Priority must be a number (0, 1, or 2)',
      value: null,
      isUrgent: false
    };
  }

  if (!validPriorities.includes(numPriority)) {
    return {
      valid: false,
      message: 'Priority must be 0 (all ok), 1 (needs attention), or 2 (urgent)',
      value: null,
      isUrgent: false
    };
  }

  return {
    valid: true,
    message: 'Priority is valid',
    value: numPriority,
    isUrgent: numPriority === 2
  };
}

/**
 * Validate options array structure for interactive questions
 * @param {Array} options - Array of option objects
 * @returns {Object} { valid: boolean, message: string }
 */
function validateOptionsArray(options) {
  if (!options) {
    return {
      valid: false,
      message: 'Options array is required'
    };
  }

  if (!Array.isArray(options)) {
    return {
      valid: false,
      message: 'Options must be an array'
    };
  }

  if (options.length === 0) {
    return {
      valid: false,
      message: 'Options array must contain at least one option'
    };
  }

  if (options.length > 10) {
    return {
      valid: false,
      message: 'Options array cannot contain more than 10 options'
    };
  }

  // Validate each option
  for (let i = 0; i < options.length; i++) {
    const option = options[i];

    if (!option || typeof option !== 'object') {
      return {
        valid: false,
        message: `Option ${i + 1} must be an object`
      };
    }

    if (!option.text || typeof option.text !== 'string') {
      return {
        valid: false,
        message: `Option ${i + 1} must have a text field`
      };
    }

    if (option.text.trim().length === 0) {
      return {
        valid: false,
        message: `Option ${i + 1} text cannot be empty`
      };
    }

    if (option.text.length > 1000) {
      return {
        valid: false,
        message: `Option ${i + 1} text exceeds maximum length of 1000 characters`
      };
    }

    // Validate optional fields if present
    if (option.benefits !== undefined && option.benefits !== null) {
      if (typeof option.benefits !== 'string') {
        return {
          valid: false,
          message: `Option ${i + 1} benefits must be a string`
        };
      }
      if (option.benefits.length > 2000) {
        return {
          valid: false,
          message: `Option ${i + 1} benefits exceeds maximum length of 2000 characters`
        };
      }
    }

    if (option.downsides !== undefined && option.downsides !== null) {
      if (typeof option.downsides !== 'string') {
        return {
          valid: false,
          message: `Option ${i + 1} downsides must be a string`
        };
      }
      if (option.downsides.length > 2000) {
        return {
          valid: false,
          message: `Option ${i + 1} downsides exceeds maximum length of 2000 characters`
        };
      }
    }

    if (option.isDefault !== undefined && option.isDefault !== null) {
      if (typeof option.isDefault !== 'boolean') {
        return {
          valid: false,
          message: `Option ${i + 1} isDefault must be a boolean`
        };
      }
    }
  }

  return {
    valid: true,
    message: 'Options array is valid'
  };
}

/**
 * Validate ISO 8601 timestamp format
 * @param {string} timestamp - Timestamp string to validate
 * @returns {Object} { valid: boolean, message: string, date: Date|null }
 */
function validateTimestamp(timestamp) {
  if (!timestamp) {
    return {
      valid: false,
      message: 'Timestamp is required',
      date: null
    };
  }

  if (typeof timestamp !== 'string') {
    return {
      valid: false,
      message: 'Timestamp must be a string',
      date: null
    };
  }

  const date = new Date(timestamp);

  if (isNaN(date.getTime())) {
    return {
      valid: false,
      message: 'Invalid timestamp format. Use ISO 8601 format (e.g., 2024-01-01T00:00:00Z)',
      date: null
    };
  }

  return {
    valid: true,
    message: 'Timestamp is valid',
    date: date
  };
}

/**
 * Validate UUID format
 * @param {string} uuid - UUID string to validate
 * @returns {boolean} True if valid UUID, false otherwise
 */
function isValidUUID(uuid) {
  if (!uuid || typeof uuid !== 'string') {
    return false;
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Validate agent name
 * @param {string} agentName - Agent name to validate
 * @returns {Object} { valid: boolean, message: string }
 */
function validateAgentName(agentName) {
  if (!agentName || typeof agentName !== 'string') {
    return {
      valid: false,
      message: 'Agent name is required'
    };
  }

  if (agentName.trim().length === 0) {
    return {
      valid: false,
      message: 'Agent name cannot be empty'
    };
  }

  if (agentName.length > 100) {
    return {
      valid: false,
      message: 'Agent name exceeds maximum length of 100 characters'
    };
  }

  return {
    valid: true,
    message: 'Agent name is valid'
  };
}

/**
 * Validate boolean value
 * @param {*} value - Value to validate as boolean
 * @param {boolean} defaultValue - Default value if not provided
 * @returns {boolean} Validated boolean value
 */
function validateBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  return value === true;
}

/**
 * Validate optional open-response hint shown to humans
 * @param {string|null} hint
 * @param {number} maxLength
 * @returns {{valid: boolean, message?: string, value: string|null}}
 */
function validateFreeResponseHint(hint, maxLength = 500) {
  if (hint === undefined || hint === null || hint === '') {
    return { valid: true, value: null };
  }

  if (typeof hint !== 'string') {
    return {
      valid: false,
      message: 'Free-response hint must be a string',
      value: null
    };
  }

  const sanitized = hint.trim();
  if (sanitized.length === 0) {
    return { valid: true, value: null };
  }

  if (sanitized.length > maxLength) {
    return {
      valid: false,
      message: `Free-response hint must be ${maxLength} characters or less`,
      value: null
    };
  }

  return { valid: true, value: sanitized };
}

/**
 * Sanitize string input (trim whitespace)
 * @param {string} input - String to sanitize
 * @returns {string} Sanitized string
 */
function sanitizeString(input) {
  if (!input || typeof input !== 'string') {
    return '';
  }

  return input.trim();
}

/**
 * Convert a Date object to a timestamp string compatible with PostgreSQL
 * when using TIMESTAMP WITHOUT TIME ZONE columns.
 * @param {Date} date - JavaScript Date object
 * @returns {string} Formatted timestamp string (YYYY-MM-DD HH:MM:SS.mmm)
 */
function formatTimestampForDatabase(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return null;
  }

  const pad = (value, size = 2) => String(value).padStart(size, '0');

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const milliseconds = pad(date.getMilliseconds(), 3);

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

/**
 * Detect potential SQL injection patterns
 * @param {string} input - Input string to check
 * @returns {boolean} True if suspicious pattern detected
 */
function detectSqlInjection(input) {
  if (!input || typeof input !== 'string') return false;
  
  const patterns = [
    /['"]\s*OR\s*['"]?\w+['"]?\s*=\s*['"]?\w+/i, // ' OR '1'='1
    /;\s*DROP\s+TABLE/i,                       // ; DROP TABLE
    /\bUNION\s+(ALL\s+)?SELECT\b/i             // UNION SELECT
  ];
  
  return patterns.some(p => p.test(input));
}

/**
 * Detect potential XSS patterns
 * @param {string} input - Input string to check
 * @returns {boolean} True if suspicious pattern detected
 */
function detectXss(input) {
  if (!input || typeof input !== 'string') return false;
  
  const patterns = [
    /<script\b[^>]*>/i,       // <script> tags
    /\bon\w+\s*=/i,           // Event handlers (onclick=, etc)
    /javascript:/i            // javascript: protocol
  ];
  
  return patterns.some(p => p.test(input));
}

module.exports = {
  isValidEmail,
  validatePasswordStrength,
  validateMessageContent,
  validateAttachmentIds,
  validatePriority,
  validateOptionsArray,
  validateTimestamp,
  isValidUUID,
  validateAgentName,
  validateBoolean,
  validateFreeResponseHint,
  sanitizeString,
  formatTimestampForDatabase,
  detectSqlInjection,
  detectXss
};
