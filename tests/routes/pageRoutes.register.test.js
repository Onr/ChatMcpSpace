const express = require('express');
const request = require('supertest');

function buildApp({ sendVerificationEmailResult = { success: true }, verifyEmailCodeResult = { success: false, error: 'Invalid code' } } = {}) {
  jest.resetModules();

  const session = {};
  const registerUser = jest.fn().mockResolvedValue({
    userId: 'user-123',
    email: 'new@example.com',
  });
  const sendVerificationEmail = jest.fn().mockResolvedValue(sendVerificationEmailResult);
  const verifyEmailCode = jest.fn().mockResolvedValue(verifyEmailCodeResult);
  const query = jest.fn().mockResolvedValue({ rows: [{ user_id: 'user-123', email: 'new@example.com', api_key: null }] });
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
    verifyEmailCode,
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
    query,
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

  return { app, session, registerUser, sendVerificationEmail, verifyEmailCode, createSession };
}

describe('pageRoutes registration email flow', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('lets an external-agent owner choose collaboration access without script injection', async () => {
    const { app } = buildApp();
    const maliciousName = '</script><script>window.injected=true</script>';
    const res = await request(app).get('/settings/external-agents/approve')
      .query({ provider: 'hermes', agentName: maliciousName }).expect(200);
    expect(res.text).toContain('Who may it collaborate with?');
    expect(res.text).toContain('value="disabled"');
    expect(res.text).toContain('value="groups" selected');
    expect(res.text).toContain('value="listen_all"');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(res.text, { runScripts: 'dangerously' });
    try {
      expect(dom.window.injected).toBeUndefined();
      dom.window.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ pairingCode: 'ABCDE-FGHJK', expiresAt: new Date().toISOString() }) });
      dom.window.document.getElementById('collaborationMode').value = 'groups';
      dom.window.document.getElementById('collaborationGroups').value = ' Project, Operations ';
      dom.window.document.getElementById('approveButton').click();
      await new Promise(resolve => setImmediate(resolve));
      const [route, options] = dom.window.fetch.mock.calls[0];
      expect(route).toBe('/api/user/external-agents/pairing-codes');
      expect(options.headers['x-csrf-token']).toBe('csrf-token');
      expect(JSON.parse(options.body)).toMatchObject({ provider: 'hermes', agentName: maliciousName,
        interAgentMode: 'groups', groupNames: ['Project', 'Operations'], canSpawn: false });
    } finally { dom.window.close(); }
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

  it('carries a valid invitation through signup and rejects malformed continuation IDs', async () => {
    const { app, session } = buildApp();
    const invitationId = 'd91ee648-e242-4db7-a82a-0f9cad64dd93';
    await request(app).get(`/join/invitation/${invitationId}`).expect(302).expect('Location', '/register');
    expect(session.pendingSharingInvitationId).toBe(invitationId);
    const registration = await request(app).get('/register').expect(200);
    expect(registration.body).toMatchObject({ view: 'register', invitationId });
    await request(app).post('/register').type('form').send({
      email: 'new@example.com', password: 'Password123!', confirmPassword: 'Password123!', invitationId
    }).expect(302);
    expect(session.pendingSharingInvitationId).toBe(invitationId);
    expect(session.pendingVerificationEmail).toBe('new@example.com');

    const other = buildApp();
    await request(other.app).get('/join/invitation/not-a-uuid').expect(302).expect('Location', '/register');
    expect(other.session.pendingSharingInvitationId).toBeUndefined();
  });

  it('redirects a newly verified invitee to the invited chat and consumes the continuation', async () => {
    const invitationId = 'd91ee648-e242-4db7-a82a-0f9cad64dd93';
    const { app, session } = buildApp({ verifyEmailCodeResult: { success: true, userId: 'user-123', alreadyVerified: false } });
    session.pendingVerificationEmail = 'new@example.com';
    session.pendingSharingInvitationId = invitationId;
    const response = await request(app).post('/verify-code').send({ email: 'new@example.com', code: '123456' }).expect(200);
    expect(response.body.redirectTo).toBe(`/dashboard?invitationId=${invitationId}`);
    expect(session.pendingSharingInvitationId).toBeUndefined();
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
