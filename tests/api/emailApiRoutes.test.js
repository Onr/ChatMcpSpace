const express = require('express');
const request = require('supertest');

const { createTestDatabase, applyEmailVerificationSchema, seedUser } = require('../utils/pgMemTestUtils');

async function createEmailApiTestContext({ emailVerified = false } = {}) {
  jest.resetModules();

  process.env.EMAIL_USER = 'test@example.com';
  process.env.EMAIL_PASSWORD = 'password';

  jest.doMock('nodemailer', () => ({
    createTransport: jest.fn(() => ({
      sendMail: jest.fn().mockResolvedValue({ messageId: 'test-message-id' }),
      verify: jest.fn().mockResolvedValue(true),
    })),
  }));

  const { pool, query } = createTestDatabase();
  await applyEmailVerificationSchema(query);
  const { userId, email } = await seedUser(query, { emailVerified });

  jest.doMock('../../src/db/connection', () => ({
    query: (text, params) => query(text, params),
    getClient: () => pool.connect(),
    pool,
  }));

  jest.doMock('../../src/middleware/authMiddleware', () => ({
    protectRoute: (req, _res, next) => {
      req.user = { userId, email, emailVerified };
      next();
    },
    requireEmailVerification: (_req, _res, next) => next(),
  }));

  const emailApiRoutes = require('../../src/routes/emailApiRoutes');

  const app = express();
  app.use(express.json());
  app.use('/api/email', emailApiRoutes);

  return { app, query, pool, userId, email };
}

describe('Email API routes', () => {
  let consoleLogSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleWarnSpy?.mockRestore();
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('verifies a token via POST /api/email/verify-token and marks the user verified', async () => {
    const { app, query, pool, userId, email } = await createEmailApiTestContext({ emailVerified: false });
    const { createVerificationToken, hashToken } = require('../../src/services/emailService');

    const token = await createVerificationToken(userId);
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const tokenRows = await query('SELECT token, token_hash FROM email_verification_tokens WHERE user_id = $1', [
      userId,
    ]);
    expect(tokenRows.rows).toHaveLength(1);
    expect(tokenRows.rows[0].token).toBe(`${token.slice(0, 16)}...`);
    expect(tokenRows.rows[0].token_hash).toBe(hashToken(token));

    const res = await request(app).post('/api/email/verify-token').send({ token }).expect(200);
    expect(res.body).toMatchObject({
      success: true,
      userId,
      email,
      alreadyVerified: false,
    });

    const userAfter = await query('SELECT email_verified, email_verified_at FROM users WHERE user_id = $1', [userId]);
    expect(userAfter.rows[0].email_verified).toBe(true);
    expect(userAfter.rows[0].email_verified_at).toBeTruthy();

    const tokenAfter = await query('SELECT used_at FROM email_verification_tokens WHERE user_id = $1', [userId]);
    expect(tokenAfter.rows[0].used_at).toBeTruthy();

    await pool.end();
  });

  it('returns 400 for an expired token via POST /api/email/verify-token', async () => {
    const { app, query, pool, userId } = await createEmailApiTestContext({ emailVerified: false });
    const { createVerificationToken } = require('../../src/services/emailService');

    const token = await createVerificationToken(userId);

    await query('UPDATE email_verification_tokens SET expires_at = $1 WHERE user_id = $2 AND used_at IS NULL', [
      new Date(Date.now() - 60 * 60 * 1000),
      userId,
    ]);

    const res = await request(app).post('/api/email/verify-token').send({ token }).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Invalid|expired/i);

    const userAfter = await query('SELECT email_verified FROM users WHERE user_id = $1', [userId]);
    expect(userAfter.rows[0].email_verified).toBe(false);

    const tokenAfter = await query('SELECT used_at FROM email_verification_tokens WHERE user_id = $1', [userId]);
    expect(tokenAfter.rows[0].used_at).toBeNull();

    await pool.end();
  });

  it('returns 400 for an invalid token via POST /api/email/verify-token', async () => {
    const { app, pool } = await createEmailApiTestContext({ emailVerified: false });

    const res = await request(app)
      .post('/api/email/verify-token')
      .send({ token: 'deadbeef'.repeat(8) })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Invalid|expired/i);

    await pool.end();
  });

  it('resends verification email and verifies the generated code via /api/email/verify-code', async () => {
    const { app, query, pool, userId, email } = await createEmailApiTestContext({ emailVerified: false });

    const resend = await request(app).post('/api/email/resend-verification').send({ email }).expect(200);
    expect(resend.body).toMatchObject({ success: true, messageId: 'test-message-id' });

    const logRow = await query(
      'SELECT subject, status, email_type, email_to FROM email_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    expect(logRow.rows).toHaveLength(1);
    expect(logRow.rows[0]).toMatchObject({ status: 'sent', email_type: 'verification', email_to: email });
    expect(logRow.rows[0].subject).toMatch(/^\d{6} is your ChatMCP\.Space verification code$/);

    const code = logRow.rows[0].subject.split(' ')[0];
    const verify = await request(app).post('/api/email/verify-code').send({ email, code }).expect(200);
    expect(verify.body).toMatchObject({ success: true, userId, email });

    const userAfter = await query('SELECT email_verified FROM users WHERE user_id = $1', [userId]);
    expect(userAfter.rows[0].email_verified).toBe(true);

    await pool.end();
  });
});
