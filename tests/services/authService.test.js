const authService = require('../../src/services/authService');
const { query } = require('../../src/db/connection');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { generateEncryptionSalt } = require('../../src/utils/encryptionHelper');

// Mock dependencies
jest.mock('../../src/db/connection');
jest.mock('bcrypt');
jest.mock('../../src/utils/encryptionHelper');

// Use spyOn instead of full module mock for crypto to avoid breaking dependencies
// We need to restore it after tests or simply mock the implementation for the suite
jest.spyOn(crypto, 'randomUUID').mockReturnValue('mock-uuid');

describe('Auth Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset mocks
    crypto.randomUUID.mockReturnValue('mock-uuid');
    generateEncryptionSalt.mockReturnValue('mock-salt');
    bcrypt.hash.mockResolvedValue('hashed-password');
    bcrypt.compare.mockResolvedValue(true);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('hashPassword', () => {
    it('should hash password with 10 salt rounds', async () => {
      await authService.hashPassword('password123');
      expect(bcrypt.hash).toHaveBeenCalledWith('password123', 10);
    });

    it('should throw error if hashing fails', async () => {
      bcrypt.hash.mockRejectedValue(new Error('Hash failed'));
      await expect(authService.hashPassword('pass')).rejects.toThrow('Failed to hash password');
    });
  });

  describe('generateApiKey', () => {
    it('should return a UUID', () => {
      const key = authService.generateApiKey();
      expect(key).toBe('mock-uuid');
      expect(crypto.randomUUID).toHaveBeenCalled();
    });
  });

  describe('registerUser', () => {
    const validUser = {
      email: 'test@example.com',
      password: 'password123'
    };

    it('should register user with valid data', async () => {
      query.mockResolvedValue({
        rows: [{
          user_id: 'user-id',
          email: validUser.email,
          api_key: 'mock-uuid',
          encryption_salt: 'mock-salt',
          created_at: new Date()
        }]
      });

      const result = await authService.registerUser(validUser.email, validUser.password);

      expect(bcrypt.hash).toHaveBeenCalledWith(validUser.password, 10);
      expect(crypto.randomUUID).toHaveBeenCalled();
      expect(generateEncryptionSalt).toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        [validUser.email, 'hashed-password', 'mock-uuid', 'mock-salt', expect.any(String)]
      );
      expect(result).toMatchObject({
        userId: 'user-id',
        email: validUser.email,
        apiKey: 'mock-uuid'
      });
    });

    it('should throw error on duplicate email', async () => {
      const error = new Error('Duplicate');
      error.code = '23505';
      error.constraint = 'users_email_key';
      query.mockRejectedValue(error);

      await expect(authService.registerUser(validUser.email, validUser.password))
        .rejects.toThrow('Email already registered');
    });

    it('should throw error on missing required field', async () => {
      const error = new Error('Missing');
      error.code = '23502';
      query.mockRejectedValue(error);

      await expect(authService.registerUser(validUser.email, validUser.password))
        .rejects.toThrow('Required field is missing');
    });

    it('should throw generic error on db failure', async () => {
      query.mockRejectedValue(new Error('DB connection failed'));
      await expect(authService.registerUser(validUser.email, validUser.password))
        .rejects.toThrow('DB connection failed');
    });
  });

  describe('validateCredentials', () => {
    const email = 'test@example.com';
    const password = 'password123';
    const mockDbUser = {
      user_id: 'user-id',
      email: email,
      password_hash: 'hashed-password',
      api_key: 'api-key',
      encryption_salt: 'salt',
      email_verified: true
    };

    it('should return user data for valid credentials', async () => {
      query.mockResolvedValue({ rows: [mockDbUser] });
      bcrypt.compare.mockResolvedValue(true);

      const result = await authService.validateCredentials(email, password);

      expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT user_id'), [email]);
      expect(bcrypt.compare).toHaveBeenCalledWith(password, 'hashed-password');
      expect(result).toEqual({
        userId: 'user-id',
        email: email,
        apiKey: 'api-key',
        encryptionSalt: 'salt'
      });
    });

    it('should return null if user not found', async () => {
      query.mockResolvedValue({ rows: [] });
      const result = await authService.validateCredentials(email, password);
      expect(result).toBeNull();
    });

    it('should return null if password invalid', async () => {
      query.mockResolvedValue({ rows: [mockDbUser] });
      bcrypt.compare.mockResolvedValue(false);
      const result = await authService.validateCredentials(email, password);
      expect(result).toBeNull();
    });

    it('should return emailNotVerified object if email not verified', async () => {
      query.mockResolvedValue({ 
        rows: [{ ...mockDbUser, email_verified: false }] 
      });
      bcrypt.compare.mockResolvedValue(true);

      const result = await authService.validateCredentials(email, password);

      expect(result).toEqual({
        emailNotVerified: true,
        email: email,
        userId: 'user-id'
      });
    });
  });

  describe('getUserByApiKey', () => {
    it('should return user for valid api key', async () => {
      const mockUser = {
        user_id: 'user-id',
        email: 'test@example.com',
        api_key: 'valid-key',
        encryption_salt: 'salt'
      };
      query.mockResolvedValue({ rows: [mockUser] });

      const result = await authService.getUserByApiKey('valid-key');

      expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE api_key = $1'), ['valid-key']);
      expect(result).toEqual({
        userId: 'user-id',
        email: 'test@example.com',
        apiKey: 'valid-key',
        encryptionSalt: 'salt'
      });
    });

    it('should return null for invalid api key', async () => {
      query.mockResolvedValue({ rows: [] });
      const result = await authService.getUserByApiKey('invalid-key');
      expect(result).toBeNull();
    });
  });

  describe('regenerateApiKey', () => {
    it('should regenerate key for existing user', async () => {
      query.mockResolvedValue({
        rows: [{ api_key: 'new-uuid' }]
      });
      crypto.randomUUID.mockReturnValue('new-uuid');

      const result = await authService.regenerateApiKey('user-id');

      expect(crypto.randomUUID).toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users'),
        ['new-uuid', 'user-id']
      );
      expect(result).toBe('new-uuid');
    });

    it('should throw error if user not found', async () => {
      query.mockResolvedValue({ rows: [] });
      await expect(authService.regenerateApiKey('user-id')).rejects.toThrow('User not found');
    });
  });
});
