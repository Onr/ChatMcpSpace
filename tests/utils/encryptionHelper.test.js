const {
  generateEncryptionSalt,
  deriveEncryptionKey,
  encryptMessage,
  decryptMessage,
  getEncryptionParams
} = require('../../src/utils/encryptionHelper');

describe('Encryption Helper', () => {
  const password = 'securePassword123';
  const salt = generateEncryptionSalt();
  const plaintext = 'Secret Message 🚀';

  describe('generateEncryptionSalt', () => {
    it('should generate a base64 string', () => {
      const s = generateEncryptionSalt();
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    });

    it('should generate unique salts', () => {
      const s1 = generateEncryptionSalt();
      const s2 = generateEncryptionSalt();
      expect(s1).not.toBe(s2);
    });
  });

  describe('deriveEncryptionKey', () => {
    it('should return a Buffer', () => {
      const key = deriveEncryptionKey(password, salt);
      expect(Buffer.isBuffer(key)).toBe(true);
    });

    it('should be deterministic', () => {
      const key1 = deriveEncryptionKey(password, salt);
      const key2 = deriveEncryptionKey(password, salt);
      expect(key1.equals(key2)).toBe(true);
    });

    it('should change with salt', () => {
      const otherSalt = generateEncryptionSalt();
      const key1 = deriveEncryptionKey(password, salt);
      const key2 = deriveEncryptionKey(password, otherSalt);
      expect(key1.equals(key2)).toBe(false);
    });

    it('should change with password', () => {
      const key1 = deriveEncryptionKey(password, salt);
      const key2 = deriveEncryptionKey('differentPassword', salt);
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('Encryption/Decryption Round Trip', () => {
    it('should successfully encrypt and decrypt', () => {
      const encrypted = encryptMessage(plaintext, password, salt);
      const decrypted = decryptMessage(encrypted, password, salt);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle special characters and unicode', () => {
      const msg = 'Testing: & < > " \' \n \t € ☃';
      const encrypted = encryptMessage(msg, password, salt);
      const decrypted = decryptMessage(encrypted, password, salt);
      expect(decrypted).toBe(msg);
    });
  });

  describe('encryptMessage', () => {
    it('should produce output in iv:tag:ciphertext format', () => {
      const encrypted = encryptMessage(plaintext, password, salt);
      const parts = encrypted.split(':');
      expect(parts.length).toBe(3);
    });

    it('should produce different outputs for same input (random IV)', () => {
      const enc1 = encryptMessage(plaintext, password, salt);
      const enc2 = encryptMessage(plaintext, password, salt);
      expect(enc1).not.toBe(enc2);
    });
  });

  describe('decryptMessage', () => {
    it('should throw error with incorrect password', () => {
      const encrypted = encryptMessage(plaintext, password, salt);
      expect(() => {
        decryptMessage(encrypted, 'wrongPassword', salt);
      }).toThrow(); // Should fail auth tag verification
    });

    it('should throw error with incorrect salt', () => {
      const encrypted = encryptMessage(plaintext, password, salt);
      const wrongSalt = generateEncryptionSalt();
      expect(() => {
        decryptMessage(encrypted, password, wrongSalt);
      }).toThrow();
    });

    it('should throw error on corrupted ciphertext', () => {
      const encrypted = encryptMessage(plaintext, password, salt);
      const parts = encrypted.split(':');
      // Tamper with ciphertext
      parts[2] = 'A' + parts[2].substring(1); 
      const corrupted = parts.join(':');
      expect(() => {
        decryptMessage(corrupted, password, salt);
      }).toThrow();
    });

    it('should throw error on invalid format', () => {
      expect(() => {
        decryptMessage('invalid:format', password, salt);
      }).toThrow('Invalid encrypted data format');
    });
  });

  describe('getEncryptionParams', () => {
    it('should return correct parameters', () => {
      const params = getEncryptionParams();
      expect(params).toEqual({
        algorithm: 'PBKDF2',
        hash: 'SHA-256',
        iterations: 100000,
        keyLength: 256,
        cipherAlgorithm: 'AES-GCM',
        ivLength: 12,
        tagLength: 128
      });
    });
  });
});
