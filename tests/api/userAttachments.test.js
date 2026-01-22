const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const { createTestDatabase, applyRuntimeUserColumns, seedUser, applyArchiveSchema } = require('../utils/pgMemTestUtils');

/**
 * Apply the image attachments schema for testing
 * Note: pg-mem has limitations, so we use a minimal schema compatible with it
 */
async function applyImageAttachmentsSchema(query) {
  // Create attachments table - minimal version for pg-mem compatibility
  // pg-mem has issues with NOT NULL constraints in CREATE TABLE, so we remove them
  await query(`
    CREATE TABLE IF NOT EXISTS attachments (
      attachment_id UUID,
      content_type VARCHAR(100),
      file_name VARCHAR(255),
      size_bytes BIGINT,
      width INTEGER,
      height INTEGER,
      iv_base64 VARCHAR(32),
      auth_tag_base64 VARCHAR(32),
      agent_id UUID,
      uploaded_by VARCHAR(10),
      created_at TIMESTAMP
    )
  `);
}

/**
 * Create a test context with mocked storage
 */
async function createAttachmentTestContext() {
  jest.resetModules();

  const { pool, query } = createTestDatabase();
  await applyRuntimeUserColumns(query);
  await applyArchiveSchema(query);
  await applyImageAttachmentsSchema(query);
  const { userId, apiKey } = await seedUser(query);

  // Mock the database connection
  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => query(text, params),
    getClient: () => pool.connect(),
    pool,
  }));

  // Mock the security logger
  jest.doMock('../../src/utils/securityLogger', () => ({
    logUnauthorizedAccess: jest.fn(),
    logApiKeyUsage: jest.fn(),
  }));

  // Mock the logger
  jest.doMock('../../src/utils/logger', () => ({
    logInfo: jest.fn(),
    logWarn: jest.fn(),
    logError: jest.fn(),
  }));

  // Mock rate limiter
  jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
    userPollingRateLimiter: (_req, _res, next) => next(),
    feedbackRateLimiter: (_req, _res, next) => next(),
  }));

  // Mock TTS service
  jest.doMock('../../src/services/ttsService', () => ({
    getAudioUrl: jest.fn().mockResolvedValue(null),
  }));

  // Mock storage provider
  const mockStorageKey = `local:${userId}/mock-agent/mock-attachment`;
  jest.doMock('../../src/storage', () => ({
    getStorageProvider: jest.fn().mockReturnValue({
      name: 'local',
      store: jest.fn().mockResolvedValue(mockStorageKey),
      retrieve: jest.fn().mockResolvedValue(Buffer.from('mock-data')),
      delete: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(true),
    }),
    initializeStorage: jest.fn().mockResolvedValue({
      name: 'local',
      store: jest.fn().mockResolvedValue(mockStorageKey),
      retrieve: jest.fn().mockResolvedValue(Buffer.from('mock-data')),
      delete: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(true),
    }),
  }));

  const userApiRoutes = require('../../src/routes/userApiRoutes');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId };
    next();
  });
  app.use('/api/user', userApiRoutes);

  return { app, query, pool, userId, apiKey };
}

describe('User Attachment Controller', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  describe('POST /api/user/attachments', () => {
    it('should require authentication', async () => {
      jest.resetModules();

      const { pool, query } = createTestDatabase();
      await applyRuntimeUserColumns(query);

      jest.doMock('../../src/db/connection', () => ({
        query: (text, params) => query(text, params),
        getClient: () => pool.connect(),
        pool,
      }));

      jest.doMock('../../src/utils/securityLogger', () => ({
        logUnauthorizedAccess: jest.fn(),
        logApiKeyUsage: jest.fn(),
      }));

      jest.doMock('../../src/utils/logger', () => ({
        logInfo: jest.fn(),
        logWarn: jest.fn(),
        logError: jest.fn(),
      }));

      jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
        userPollingRateLimiter: (_req, _res, next) => next(),
        feedbackRateLimiter: (_req, _res, next) => next(),
      }));

      jest.doMock('../../src/services/ttsService', () => ({
        getAudioUrl: jest.fn().mockResolvedValue(null),
      }));

      const userApiRoutes = require('../../src/routes/userApiRoutes');
      const app = express();
      app.use(express.json());
      // No session middleware - simulates unauthenticated request
      app.use('/api/user', userApiRoutes);

      const res = await request(app)
        .post('/api/user/attachments')
        .expect(401);

      expect(res.body.error.code).toBe('AUTH_MISSING_CREDENTIALS');
      await pool.end();
    });

    it('should require agentId field', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      const agentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        agentId,
        userId,
        'TestAgent',
        1,
      ]);

      const res = await request(app)
        .post('/api/user/attachments')
        .field('ivBase64', 'dGVzdGl2MTIzNDU2') // 12 bytes base64
        .field('authTagBase64', 'dGVzdGF1dGh0YWcxMjM0NTY3OA==') // 16 bytes base64
        .field('contentType', 'image/png')
        .attach('file', Buffer.from('fake-encrypted-data'), 'test.png')
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Agent ID is required');
      await pool.end();
    });

    it('should require file field', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      const agentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        agentId,
        userId,
        'TestAgent',
        1,
      ]);

      const res = await request(app)
        .post('/api/user/attachments')
        .field('agentId', agentId)
        .field('ivBase64', 'dGVzdGl2MTIzNDU2')
        .field('authTagBase64', 'dGVzdGF1dGh0YWcxMjM0NTY3OA==')
        .field('contentType', 'image/png')
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('File is required');
      await pool.end();
    });

    it('should require ivBase64 field', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      const agentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        agentId,
        userId,
        'TestAgent',
        1,
      ]);

      const res = await request(app)
        .post('/api/user/attachments')
        .field('agentId', agentId)
        .field('authTagBase64', 'dGVzdGF1dGh0YWcxMjM0NTY3OA==')
        .field('contentType', 'image/png')
        .attach('file', Buffer.from('fake-encrypted-data'), 'test.png')
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('IV (ivBase64) is required');
      await pool.end();
    });

    it('should require authTagBase64 field', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      const agentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        agentId,
        userId,
        'TestAgent',
        1,
      ]);

      const res = await request(app)
        .post('/api/user/attachments')
        .field('agentId', agentId)
        .field('ivBase64', 'dGVzdGl2MTIzNDU2')
        .field('contentType', 'image/png')
        .attach('file', Buffer.from('fake-encrypted-data'), 'test.png')
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Auth tag (authTagBase64) is required');
      await pool.end();
    });

    it('should require contentType field', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      const agentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        agentId,
        userId,
        'TestAgent',
        1,
      ]);

      const res = await request(app)
        .post('/api/user/attachments')
        .field('agentId', agentId)
        .field('ivBase64', 'dGVzdGl2MTIzNDU2')
        .field('authTagBase64', 'dGVzdGF1dGh0YWcxMjM0NTY3OA==')
        .attach('file', Buffer.from('fake-encrypted-data'), 'test.png')
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Content type is required');
      await pool.end();
    });

    it('should reject invalid content types', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      const agentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        agentId,
        userId,
        'TestAgent',
        1,
      ]);

      const res = await request(app)
        .post('/api/user/attachments')
        .field('agentId', agentId)
        .field('ivBase64', 'dGVzdGl2MTIzNDU2')
        .field('authTagBase64', 'dGVzdGF1dGh0YWcxMjM0NTY3OA==')
        .field('contentType', 'video/mp4')
        .attach('file', Buffer.from('fake-encrypted-data'), 'test.mp4')
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Content type must be one of');
      await pool.end();
    });

    it('should reject access to agents not owned by the user', async () => {
      const { app, query, pool } = await createAttachmentTestContext();

      // Create another user and their agent
      const otherUserId = uuidv4();
      await query(
        'INSERT INTO users (user_id, email, password_hash, api_key, encryption_salt, email_verified) VALUES ($1, $2, $3, $4, $5, TRUE)',
        [otherUserId, 'other@example.com', 'hash', 'api-key-other', 'salt']
      );

      const otherAgentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        otherAgentId,
        otherUserId,
        'OtherAgent',
        1,
      ]);

      const res = await request(app)
        .post('/api/user/attachments')
        .field('agentId', otherAgentId)
        .field('ivBase64', 'dGVzdGl2MTIzNDU2')
        .field('authTagBase64', 'dGVzdGF1dGh0YWcxMjM0NTY3OA==')
        .field('contentType', 'image/png')
        .attach('file', Buffer.from('fake-encrypted-data'), 'test.png')
        .expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN_RESOURCE');
      await pool.end();
    });

    it('should successfully upload an attachment', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      const agentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        agentId,
        userId,
        'TestAgent',
        1,
      ]);

      const res = await request(app)
        .post('/api/user/attachments')
        .field('agentId', agentId)
        .field('ivBase64', 'dGVzdGl2MTIzNDU2')
        .field('authTagBase64', 'dGVzdGF1dGh0YWcxMjM0NTY3OA==')
        .field('contentType', 'image/png')
        .field('width', '512')
        .field('height', '512')
        .attach('file', Buffer.from('fake-encrypted-data'), 'test.png')
        .expect(201);

      expect(res.body.attachment.attachmentId).toBeDefined();
      expect(res.body.attachment.contentType).toBe('image/png');
      expect(res.body.attachment.sizeBytes).toBe(Buffer.from('fake-encrypted-data').length);
      expect(res.body.attachment.width).toBe(512);
      expect(res.body.attachment.height).toBe(512);
      expect(res.body.attachment.encrypted).toBe(true);
      expect(res.body.attachment.encryption).toEqual({
        alg: 'AES-GCM',
        ivBase64: 'dGVzdGl2MTIzNDU2',
        tagBase64: 'dGVzdGF1dGh0YWcxMjM0NTY3OA==',
      });

      // Verify database record
      const dbResult = await query('SELECT * FROM attachments WHERE attachment_id = $1', [res.body.attachment.attachmentId]);
      expect(dbResult.rows.length).toBe(1);
      expect(dbResult.rows[0].content_type).toBe('image/png');
      expect(dbResult.rows[0].encrypted).toBe(true);
      expect(dbResult.rows[0].uploaded_by).toBe('user');

      await pool.end();
    });

    it('should accept optional sha256 hash', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      const agentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        agentId,
        userId,
        'TestAgent',
        1,
      ]);

      const sha256 = 'a'.repeat(64); // Valid SHA-256 hash (64 hex chars)

      const res = await request(app)
        .post('/api/user/attachments')
        .field('agentId', agentId)
        .field('ivBase64', 'dGVzdGl2MTIzNDU2')
        .field('authTagBase64', 'dGVzdGF1dGh0YWcxMjM0NTY3OA==')
        .field('contentType', 'image/jpeg')
        .field('sha256', sha256)
        .attach('file', Buffer.from('fake-encrypted-data'), 'test.jpg')
        .expect(201);

      expect(res.body.attachment.attachmentId).toBeDefined();

      // Verify sha256 is stored
      const dbResult = await query('SELECT sha256 FROM attachments WHERE attachment_id = $1', [res.body.attachment.attachmentId]);
      expect(dbResult.rows[0].sha256).toBe(sha256);

      await pool.end();
    });

    it('should reject invalid sha256 format', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      const agentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        agentId,
        userId,
        'TestAgent',
        1,
      ]);

      const res = await request(app)
        .post('/api/user/attachments')
        .field('agentId', agentId)
        .field('ivBase64', 'dGVzdGl2MTIzNDU2')
        .field('authTagBase64', 'dGVzdGF1dGh0YWcxMjM0NTY3OA==')
        .field('contentType', 'image/png')
        .field('sha256', 'invalid-hash')
        .attach('file', Buffer.from('fake-encrypted-data'), 'test.png')
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Invalid sha256 format');

      await pool.end();
    });
  });

  describe('GET /api/user/attachments/:attachmentId', () => {
    it('should require authentication', async () => {
      jest.resetModules();

      const { pool, query } = createTestDatabase();
      await applyRuntimeUserColumns(query);

      jest.doMock('../../src/db/connection', () => ({
        query: (text, params) => query(text, params),
        getClient: () => pool.connect(),
        pool,
      }));

      jest.doMock('../../src/utils/securityLogger', () => ({
        logUnauthorizedAccess: jest.fn(),
        logApiKeyUsage: jest.fn(),
      }));

      jest.doMock('../../src/utils/logger', () => ({
        logInfo: jest.fn(),
        logWarn: jest.fn(),
        logError: jest.fn(),
      }));

      jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
        userPollingRateLimiter: (_req, _res, next) => next(),
        feedbackRateLimiter: (_req, _res, next) => next(),
      }));

      jest.doMock('../../src/services/ttsService', () => ({
        getAudioUrl: jest.fn().mockResolvedValue(null),
      }));

      const userApiRoutes = require('../../src/routes/userApiRoutes');
      const app = express();
      app.use(express.json());
      // No session middleware - simulates unauthenticated request
      app.use('/api/user', userApiRoutes);

      const res = await request(app)
        .get(`/api/user/attachments/${uuidv4()}`)
        .expect(401);

      expect(res.body.error.code).toBe('AUTH_MISSING_CREDENTIALS');
      await pool.end();
    });

    it('should reject invalid attachment ID format', async () => {
      const { app, pool } = await createAttachmentTestContext();

      const res = await request(app)
        .get('/api/user/attachments/not-a-uuid')
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Invalid attachment ID format');
      await pool.end();
    });

    it('should return 404 for non-existent attachment', async () => {
      const { app, pool } = await createAttachmentTestContext();

      const res = await request(app)
        .get(`/api/user/attachments/${uuidv4()}`)
        .expect(404);

      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
      await pool.end();
    });

    it('should return 404 for attachment belonging to another user', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      // Create another user and their agent
      const otherUserId = uuidv4();
      await query(
        'INSERT INTO users (user_id, email, password_hash, api_key, encryption_salt, email_verified) VALUES ($1, $2, $3, $4, $5, TRUE)',
        [otherUserId, 'other@example.com', 'hash', 'api-key-other', 'salt']
      );

      const otherAgentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        otherAgentId,
        otherUserId,
        'OtherAgent',
        1,
      ]);

      // Create an attachment owned by the other user
      const attachmentId = uuidv4();
      await query(
        `INSERT INTO attachments (attachment_id, content_type, size_bytes, storage_provider, storage_key, encrypted, agent_id, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [attachmentId, 'image/png', 1024, 'local', `local:${otherUserId}/${otherAgentId}/${attachmentId}`, true, otherAgentId, 'user']
      );

      const res = await request(app)
        .get(`/api/user/attachments/${attachmentId}`)
        .expect(404);

      // Returns 404 to avoid leaking existence information
      expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
      await pool.end();
    });

    it('should successfully download an attachment owned by the user', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      const agentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        agentId,
        userId,
        'TestAgent',
        1,
      ]);

      // Create an attachment
      const attachmentId = uuidv4();
      const storageKey = `local:${userId}/${agentId}/${attachmentId}`;
      await query(
        `INSERT INTO attachments (attachment_id, content_type, file_name, size_bytes, storage_provider, storage_key, encrypted, agent_id, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [attachmentId, 'image/png', 'test.png', 9, 'local', storageKey, true, agentId, 'user']
      );

      const res = await request(app)
        .get(`/api/user/attachments/${attachmentId}`)
        .expect(200);

      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-length']).toBe('9');
      expect(res.headers['cache-control']).toBe('private, max-age=3600');
      expect(res.headers['content-disposition']).toBe('inline; filename="test.png"');
      // The mock returns 'mock-data' (9 bytes)
      expect(res.body.toString()).toBe('mock-data');
      await pool.end();
    });

    it('should work without filename in Content-Disposition when file_name is null', async () => {
      const { app, query, pool, userId } = await createAttachmentTestContext();

      const agentId = uuidv4();
      await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1, $2, $3, $4)', [
        agentId,
        userId,
        'TestAgent',
        1,
      ]);

      // Create an attachment without filename
      const attachmentId = uuidv4();
      const storageKey = `local:${userId}/${agentId}/${attachmentId}`;
      await query(
        `INSERT INTO attachments (attachment_id, content_type, size_bytes, storage_provider, storage_key, encrypted, agent_id, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [attachmentId, 'image/png', 9, 'local', storageKey, true, agentId, 'user']
      );

      const res = await request(app)
        .get(`/api/user/attachments/${attachmentId}`)
        .expect(200);

      expect(res.headers['content-type']).toBe('application/octet-stream');
      // No Content-Disposition header when filename is null
      expect(res.headers['content-disposition']).toBeUndefined();
      await pool.end();
    });
  });
});

describe('Helper functions', () => {
  describe('isValidBase64', () => {
    let isValidBase64;

    beforeEach(() => {
      jest.resetModules();
      jest.doMock('../../src/db/connection', () => ({
        query: jest.fn(),
        getClient: jest.fn(),
      }));
      jest.doMock('../../src/utils/securityLogger', () => ({
        logUnauthorizedAccess: jest.fn(),
      }));
      jest.doMock('../../src/utils/logger', () => ({
        logInfo: jest.fn(),
        logWarn: jest.fn(),
        logError: jest.fn(),
      }));
      jest.doMock('../../src/storage', () => ({
        getStorageProvider: jest.fn(),
        initializeStorage: jest.fn(),
      }));

      const controller = require('../../src/controllers/userAttachmentController');
      isValidBase64 = controller.isValidBase64;
    });

    it('should return false for null/undefined', () => {
      expect(isValidBase64(null)).toBe(false);
      expect(isValidBase64(undefined)).toBe(false);
    });

    it('should return false for non-strings', () => {
      expect(isValidBase64(123)).toBe(false);
      expect(isValidBase64({})).toBe(false);
    });

    it('should return true for valid base64 strings', () => {
      expect(isValidBase64('dGVzdA==')).toBe(true);
      expect(isValidBase64('dGVzdGl2MTIzNDU2')).toBe(true);
    });

    it('should return false for invalid base64 strings', () => {
      expect(isValidBase64('not!valid@base64')).toBe(false);
    });
  });

  describe('sanitizeFilename', () => {
    let sanitizeFilename;

    beforeEach(() => {
      jest.resetModules();
      jest.doMock('../../src/db/connection', () => ({
        query: jest.fn(),
        getClient: jest.fn(),
      }));
      jest.doMock('../../src/utils/securityLogger', () => ({
        logUnauthorizedAccess: jest.fn(),
      }));
      jest.doMock('../../src/utils/logger', () => ({
        logInfo: jest.fn(),
        logWarn: jest.fn(),
        logError: jest.fn(),
      }));
      jest.doMock('../../src/storage', () => ({
        getStorageProvider: jest.fn(),
        initializeStorage: jest.fn(),
      }));

      const controller = require('../../src/controllers/userAttachmentController');
      sanitizeFilename = controller.sanitizeFilename;
    });

    it('should return null for null/undefined', () => {
      expect(sanitizeFilename(null)).toBe(null);
      expect(sanitizeFilename(undefined)).toBe(null);
    });

    it('should remove path components', () => {
      expect(sanitizeFilename('/path/to/file.png')).toBe('file.png');
      expect(sanitizeFilename('C:\\Users\\test\\file.png')).toBe('file.png');
    });

    it('should remove directory traversal attempts', () => {
      // After removing path components and .., only the filename remains
      expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
    });

    it('should limit filename length', () => {
      const longName = 'a'.repeat(250) + '.png';
      const result = sanitizeFilename(longName);
      expect(result.length).toBeLessThanOrEqual(200);
      expect(result.endsWith('.png')).toBe(true);
    });
  });
});
