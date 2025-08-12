const logger = require('./logger');

/**
 * Input validation and sanitization utilities
 */
class InputValidator {
  /**
   * Validate and sanitize a string input
   * @param {string} input - The input string
   * @param {Object} options - Validation options
   * @returns {string|null} - Sanitized string or null if invalid
   */
  static validateString(input, options = {}) {
    const {
      minLength = 0,
      maxLength = 1000,
      pattern = null,
      required = false,
      trim = true,
      allowEmpty = false
    } = options;

    // Check if input is required
    if (required && (!input || input === '')) {
      logger.debug('VALIDATION', `String validation failed: required field is empty`);
      return null;
    }

    // Handle empty input
    if (!input || input === '') {
      return allowEmpty ? '' : null;
    }

    // Ensure input is string
    const str = String(input);

    // Trim if requested
    const sanitized = trim ? str.trim() : str;

    // Check length constraints
    if (sanitized.length < minLength) {
      logger.debug('VALIDATION', `String validation failed: too short (${sanitized.length} < ${minLength})`);
      return null;
    }

    if (sanitized.length > maxLength) {
      logger.debug('VALIDATION', `String validation failed: too long (${sanitized.length} > ${maxLength})`);
      return null;
    }

    // Check pattern if provided
    if (pattern && !pattern.test(sanitized)) {
      logger.debug('VALIDATION', `String validation failed: pattern mismatch`);
      return null;
    }

    return sanitized;
  }

  /**
   * Validate and sanitize a number input
   * @param {any} input - The input value
   * @param {Object} options - Validation options
   * @returns {number|null} - Validated number or null if invalid
   */
  static validateNumber(input, options = {}) {
    const {
      min = -Infinity,
      max = Infinity,
      integer = false,
      required = false
    } = options;

    // Check if input is required
    if (required && (input === null || input === undefined || input === '')) {
      logger.debug('VALIDATION', `Number validation failed: required field is empty`);
      return null;
    }

    // Handle empty input
    if (input === null || input === undefined || input === '') {
      return null;
    }

    // Convert to number
    const num = Number(input);

    // Check if it's a valid number
    if (isNaN(num)) {
      logger.debug('VALIDATION', `Number validation failed: not a valid number`);
      return null;
    }

    // Check integer constraint
    if (integer && !Number.isInteger(num)) {
      logger.debug('VALIDATION', `Number validation failed: not an integer`);
      return null;
    }

    // Check range constraints
    if (num < min) {
      logger.debug('VALIDATION', `Number validation failed: too small (${num} < ${min})`);
      return null;
    }

    if (num > max) {
      logger.debug('VALIDATION', `Number validation failed: too large (${num} > ${max})`);
      return null;
    }

    return num;
  }

  /**
   * Validate and sanitize an email address
   * @param {string} input - The email input
   * @param {Object} options - Validation options
   * @returns {string|null} - Sanitized email or null if invalid
   */
  static validateEmail(input, options = {}) {
    const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    
    return this.validateString(input, {
      ...options,
      pattern: emailPattern,
      maxLength: 254 // RFC 5321 limit
    });
  }

  /**
   * Validate and sanitize a URL
   * @param {string} input - The URL input
   * @param {Object} options - Validation options
   * @returns {string|null} - Sanitized URL or null if invalid
   */
  static validateUrl(input, options = {}) {
    try {
      const url = new URL(input);
      return url.toString();
    } catch (error) {
      logger.debug('VALIDATION', `URL validation failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Validate and sanitize a wallet address
   * @param {string} input - The address input
   * @param {Object} options - Validation options
   * @returns {string|null} - Sanitized address or null if invalid
   */
  static validateAddress(input, options = {}) {
    const addressPattern = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
    
    return this.validateString(input, {
      ...options,
      pattern: addressPattern,
      minLength: 26,
      maxLength: 35
    });
  }

  /**
   * Validate and sanitize a transaction hash
   * @param {string} input - The hash input
   * @param {Object} options - Validation options
   * @returns {string|null} - Sanitized hash or null if invalid
   */
  static validateHash(input, options = {}) {
    const hashPattern = /^[a-fA-F0-9]{64}$/;
    
    return this.validateString(input, {
      ...options,
      pattern: hashPattern,
      minLength: 64,
      maxLength: 64
    });
  }

  /**
   * Validate and sanitize a port number
   * @param {any} input - The port input
   * @param {Object} options - Validation options
   * @returns {number|null} - Validated port or null if invalid
   */
  static validatePort(input, options = {}) {
    return this.validateNumber(input, {
      ...options,
      min: 1,
      max: 65535,
      integer: true
    });
  }

  /**
   * Validate and sanitize an object with schema
   * @param {Object} input - The input object
   * @param {Object} schema - Validation schema
   * @returns {Object|null} - Validated object or null if invalid
   */
  static validateObject(input, schema) {
    if (!input || typeof input !== 'object') {
      logger.debug('VALIDATION', `Object validation failed: not an object`);
      return null;
    }

    const result = {};
    
    for (const [key, validator] of Object.entries(schema)) {
      const value = input[key];
      const validated = validator(value);
      
      if (validated === null) {
        logger.debug('VALIDATION', `Object validation failed: invalid field '${key}'`);
        return null;
      }
      
      result[key] = validated;
    }

    return result;
  }

  /**
   * Validate and sanitize an array
   * @param {Array} input - The input array
   * @param {Function} itemValidator - Validator function for each item
   * @param {Object} options - Validation options
   * @returns {Array|null} - Validated array or null if invalid
   */
  static validateArray(input, itemValidator, options = {}) {
    const {
      minLength = 0,
      maxLength = 1000,
      required = false
    } = options;

    // Check if input is required
    if (required && (!input || !Array.isArray(input))) {
      logger.debug('VALIDATION', `Array validation failed: required field is not an array`);
      return null;
    }

    // Handle empty input
    if (!input || !Array.isArray(input)) {
      return [];
    }

    // Check length constraints
    if (input.length < minLength) {
      logger.debug('VALIDATION', `Array validation failed: too short (${input.length} < ${minLength})`);
      return null;
    }

    if (input.length > maxLength) {
      logger.debug('VALIDATION', `Array validation failed: too long (${input.length} > ${maxLength})`);
      return null;
    }

    // Validate each item
    const result = [];
    for (let i = 0; i < input.length; i++) {
      const validated = itemValidator(input[i]);
      if (validated === null) {
        logger.debug('VALIDATION', `Array validation failed: invalid item at index ${i}`);
        return null;
      }
      result.push(validated);
    }

    return result;
  }

  /**
   * Sanitize HTML content to prevent XSS
   * @param {string} input - The input string
   * @returns {string} - Sanitized string
   */
  static sanitizeHtml(input) {
    if (!input || typeof input !== 'string') {
      return '';
    }

    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }

  /**
   * Sanitize SQL content to prevent injection
   * @param {string} input - The input string
   * @returns {string} - Sanitized string
   */
  static sanitizeSql(input) {
    if (!input || typeof input !== 'string') {
      return '';
    }

    // Remove SQL injection patterns
    return input
      .replace(/['";]/g, '')
      .replace(/--/g, '')
      .replace(/\/\*/g, '')
      .replace(/\*\//g, '')
      .replace(/union\s+select/gi, '')
      .replace(/drop\s+table/gi, '')
      .replace(/delete\s+from/gi, '')
      .replace(/insert\s+into/gi, '')
      .replace(/update\s+set/gi, '');
  }
}

module.exports = InputValidator;
