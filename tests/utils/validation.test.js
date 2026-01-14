const {
  isValidEmail,
  validatePasswordStrength,
  validateMessageContent,
  detectSqlInjection,
  detectXss
} = require('../../src/utils/validation');

describe('Input Validation Utils', () => {
  
  describe('isValidEmail', () => {
    it('should validate correct emails', () => {
      expect(isValidEmail('test@example.com')).toBe(true);
      expect(isValidEmail('user.name@domain.co.uk')).toBe(true);
    });

    it('should reject invalid emails', () => {
      expect(isValidEmail('invalid')).toBe(false);
      expect(isValidEmail('user@')).toBe(false);
      expect(isValidEmail('@domain.com')).toBe(false);
      expect(isValidEmail('user@domain')).toBe(false);
    });

    it('should handle boundary cases', () => {
      expect(isValidEmail('')).toBe(false);
      expect(isValidEmail(null)).toBe(false);
      expect(isValidEmail(undefined)).toBe(false);
      // Very long string
      expect(isValidEmail('a'.repeat(1000) + '@example.com')).toBe(true); 
    });
  });

  describe('validatePasswordStrength', () => {
    it('should validate strong passwords', () => {
      expect(validatePasswordStrength('Password123').valid).toBe(true);
    });

    it('should reject short passwords', () => {
      const res = validatePasswordStrength('Pass1');
      expect(res.valid).toBe(false);
      expect(res.message).toMatch(/at least 8 characters/);
    });

    it('should require letters', () => {
      const res = validatePasswordStrength('12345678');
      expect(res.valid).toBe(false);
      expect(res.message).toMatch(/contain at least one letter/);
    });

    it('should require numbers', () => {
      const res = validatePasswordStrength('Password');
      expect(res.valid).toBe(false);
      expect(res.message).toMatch(/contain at least one number/);
    });

    it('should handle special characters', () => {
      expect(validatePasswordStrength('P@ssw0rd!').valid).toBe(true);
      // Must contain at least one [a-zA-Z] letter
      expect(validatePasswordStrength('Pass密码123456').valid).toBe(true); 
    });
  });

  describe('validateMessageContent', () => {
    it('should validate normal content', () => {
      expect(validateMessageContent('Hello world').valid).toBe(true);
    });

    it('should reject empty content', () => {
      expect(validateMessageContent('').valid).toBe(false);
      expect(validateMessageContent('   ').valid).toBe(false);
    });

    it('should reject too long content', () => {
      const longText = 'a'.repeat(100001);
      const res = validateMessageContent(longText, 100000);
      expect(res.valid).toBe(false);
      expect(res.message).toMatch(/exceeds maximum length/);
    });

    it('should handle unicode', () => {
      expect(validateMessageContent('🌟🚀').valid).toBe(true);
    });
  });

  describe('detectSqlInjection', () => {
    it('should detect OR based injection', () => {
      expect(detectSqlInjection("' OR '1'='1")).toBe(true);
      expect(detectSqlInjection('" OR "1"="1')).toBe(true);
    });

    it('should detect DROP TABLE', () => {
      expect(detectSqlInjection("'; DROP TABLE users")).toBe(true);
      expect(detectSqlInjection("admin'; DROP TABLE users;--")).toBe(true);
    });

    it('should detect UNION based injection', () => {
      expect(detectSqlInjection("' UNION SELECT 1, 2")).toBe(true);
      expect(detectSqlInjection("UNION ALL SELECT")).toBe(true);
    });

    it('should ignore safe input', () => {
      expect(detectSqlInjection("Hello world")).toBe(false);
      expect(detectSqlInjection("O'Reilly")).toBe(false); // Common surname
      expect(detectSqlInjection("Drop it like it's hot")).toBe(false);
    });

    it('should handle boundary cases', () => {
      expect(detectSqlInjection('')).toBe(false);
      expect(detectSqlInjection(null)).toBe(false);
    });
  });

  describe('detectXss', () => {
    it('should detect script tags', () => {
      expect(detectXss('<script>alert(1)</script>')).toBe(true);
      expect(detectXss('Hello <SCRIPT>console.log("xss")</SCRIPT>')).toBe(true);
    });

    it('should detect event handlers', () => {
      expect(detectXss('<img src=x onerror=alert(1)>')).toBe(true);
      expect(detectXss('<div onclick="malicious()">Click me</div>')).toBe(true);
    });

    it('should detect javascript protocol', () => {
      expect(detectXss('<a href="javascript:alert(1)">Link</a>')).toBe(true);
    });

    it('should ignore safe input', () => {
      expect(detectXss('Hello world')).toBe(false);
      expect(detectXss('Check out this script for the play')).toBe(false);
      expect(detectXss('1 + 1 = 2')).toBe(false);
    });

    it('should handle boundary cases', () => {
      expect(detectXss('')).toBe(false);
      expect(detectXss(null)).toBe(false);
    });
  });
});
