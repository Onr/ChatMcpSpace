const express = require('express');
const request = require('supertest');

function buildApp({ sendVerificationEmailResult = { success: true } } = {}) {
  jest.resetModules();

  const session = {};
  const registerUser = jest.fn().mockResolvedValue({
    userId: 'user-123',
    email: 'new@example.com',
  });
  const sendVerificationEmail = jest.fn().mockResolvedValue(sendVerificationEmailResult);
  const createSession = jest.fn().mockResolvedValue(undefined);

  jest.doMock('passport', () => ({
    authenticate: () => (_req, _res, next) => next(),
  }));
  jest.doMock('../../src/services/authService', () => ({
    registerUser,
    validateCredentials: jest.fn(),
    createSession,
    destroySession: jest.fn(),
    regenerateApiKey: jest.fn(),
  }));
  jest.doMock('../../src/services/mfaService', () => ({
    buildOtpAuthUrl: jest.fn(),
    disableUserMfa: jest.fn(),
    enableUserTotp: jest.fn(),
    generateTotpSecret: jest.fn(),
    getUserMfaRecord: jest.fn(),
    isPendingMfaExpired: jest.fn().mockReturnValue(false),
    isUserMfaEnabled: jest.fn().mockReturnValue(false),
    verifyTotpToken: jest.fn(),
    verifyUserMfaCode: jest.fn(),
    verifyUserTotpToken: jest.fn(),
  }));
  jest.doMock('../../src/services/emailService', () => ({
    sendVerificationEmail,
    verifyEmailToken: jest.fn(),
    verifyEmailCode: jest.fn(),
    resendVerificationEmail: jest.fn(),
    isEmailVerified: jest.fn().mockResolvedValue(false),
  }));
  jest.doMock('../../src/middleware/authMiddleware', () => ({
    protectRoute: (_req, _res, next) => next(),
  }));
  jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({
    authRateLimiter: (_req, _res, next) => next(),
  }));
  jest.doMock('../../src/middleware/csrfMiddleware', () => ({
    csrfProtection: (_req, _res, next) => next(),
    validateCsrfToken: (_req, _res, next) => next(),
  }));
  jest.doMock('../../src/utils/securityLogger', () => ({
    logAuthenticationFailure: jest.fn(),
  }));
  jest.doMock('../../src/db/connection', () => ({
    query: jest.fn(),
  }));
  jest.doMock('../../src/utils/validation', () => ({
    isValidEmail: jest.fn().mockReturnValue(true),
    validatePasswordStrength: jest.fn().mockReturnValue({ valid: true }),
  }));
  jest.doMock('../../src/utils/apiGuideGenerator', () => ({
    generateApiGuide: jest.fn(),
    generateDirectSetupScript: jest.fn(),
    generateMainCLIScript: jest.fn(),
  }));
  jest.doMock('../../src/utils/encryptionHelper', () => ({
    generateEncryptionSalt: jest.fn(),
  }));
  jest.doMock('../../src/utils/modelCatalog', () => ({
    getProviderModelCatalog: jest.fn().mockResolvedValue([]),
  }));
  jest.doMock('../../src/utils/agentStopUtils', () => ({
    readPidFromFile: jest.fn(),
    terminateProcessWithEscalation: jest.fn(),
  }));
  jest.doMock('../../src/services/agentRuntimeConfigService', () => ({
    DEFAULT_DASHBOARD_CONFIG: {},
    loadAgentRuntimeState: jest.fn(),
    persistAgentRuntimeState: jest.fn(),
    syncRuntimeStateToFilesystem: jest.fn(),
  }));
  jest.doMock('../../public/js/marble-generator', () =>
    jest.fn().mockImplementation(() => ({ generate: jest.fn() }))
  );

  const pageRoutes = require('../../src/routes/pageRoutes');

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = session;
    res.locals.csrfToken = 'csrf-token';
    res.render = (view, locals) => res.status(200).json({ view, ...locals });
    next();
  });
  app.use(pageRoutes);

  return { app, session, registerUser, sendVerificationEmail, createSession };
}

describe('pageRoutes registration email flow', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('redirects to verify-email-sent after successful registration and send', async () => {
    const { app, session, sendVerificationEmail } = buildApp({
      sendVerificationEmailResult: { success: true, messageId: 'msg-1' },
    });

    const res = await request(app)
      .post('/register')
      .type('form')
      .send({
        email: 'new@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      })
      .expect(302);

    expect(res.headers.location).toBe('/verify-email-sent');
    expect(session.pendingVerificationEmail).toBe('new@example.com');
    expect(session.verificationSendError).toBeUndefined();
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      'user-123',
      'new@example.com',
      expect.objectContaining({
        ip: expect.any(String),
      })
    );
  });

  it('surfaces the initial send failure on verify-email-sent so the user can retry', async () => {
    const { app, session } = buildApp({
      sendVerificationEmailResult: { success: false, error: 'SMTP timeout' },
    });

    await request(app)
      .post('/register')
      .type('form')
      .send({
        email: 'new@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      })
      .expect(302);

    expect(session.pendingVerificationEmail).toBe('new@example.com');
    expect(session.verificationSendError).toBe('SMTP timeout');

    const page = await request(app).get('/verify-email-sent').expect(200);
    expect(page.body).toMatchObject({
      view: 'verify-email-sent',
      email: 'new@example.com',
      sendError: 'SMTP timeout',
    });
    expect(session.verificationSendError).toBeUndefined();
  });
});

describe('pageRoutes registration in local mode', () => {
  beforeEach(() => {
    process.env.LOCAL_MODE = 'true';
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    delete process.env.LOCAL_MODE;
    delete process.env.NODE_ENV;
    jest.resetModules();
    jest.clearAllMocks();
  });

  const registration = {
    email: 'new@example.com',
    password: 'Password123!',
    confirmPassword: 'Password123!',
  };

  it('signs the new user straight in and skips the verification email', async () => {
    const { app, createSession, sendVerificationEmail } = buildApp();

    const res = await request(app)
      .post('/register')
      .type('form')
      .send(registration)
      .expect(302);

    expect(res.headers.location).toBe('/dashboard');
    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-123' })
    );
  });

  it('does not leave a pending verification email on the session', async () => {
    const { app, session } = buildApp();

    await request(app).post('/register').type('form').send(registration).expect(302);

    expect(session.pendingVerificationEmail).toBeUndefined();
  });

  it('still requires an email and a password', async () => {
    const { app, registerUser } = buildApp();

    const res = await request(app)
      .post('/register')
      .type('form')
      .send({ email: '', password: '' })
      .expect(200);

    expect(res.body).toMatchObject({ view: 'register' });
    expect(res.body.error).toMatch(/required/i);
    expect(registerUser).not.toHaveBeenCalled();
  });

  it('falls back to the verification flow under NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const { app, createSession, sendVerificationEmail } = buildApp();

    const res = await request(app)
      .post('/register')
      .type('form')
      .send(registration)
      .expect(302);

    expect(res.headers.location).toBe('/verify-email-sent');
    expect(sendVerificationEmail).toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();

    console.error.mockRestore();
  });
});
