const express = require('express');
const request = require('supertest');

function buildApp({ mfa = false, google = false } = {}) {
  jest.resetModules();
  const session = {
    mcpOAuthReturnTo: '/oauth/authorize?client_id=known&state=opaque',
    mcpOAuthReturnToExpiresAt: Date.now() + 60_000,
    save(callback) { callback(null); }
  };
  const createSession = jest.fn(async (_req, user) => {
    session.userId = user.userId;
    session.email = user.email;
  });
  const validateCredentials = jest.fn().mockResolvedValue({ userId: 'user-1', email: 'user@example.com' });
  const verifyUserMfaCode = jest.fn().mockResolvedValue(true);
  jest.doMock('passport', () => ({
    authenticate: (_provider, options) => (req, _res, next) => {
      if (options?.failureRedirect) req.user = { userId: 'user-1', email: 'user@example.com' };
      next();
    }
  }));
  jest.doMock('../../src/services/authService', () => ({
    registerUser: jest.fn(), validateCredentials, createSession,
    destroySession: jest.fn(), regenerateApiKey: jest.fn()
  }));
  jest.doMock('../../src/services/mfaService', () => ({
    buildOtpAuthUrl: jest.fn(), disableUserMfa: jest.fn(), enableUserTotp: jest.fn(),
    generateTotpSecret: jest.fn(), getUserMfaRecord: jest.fn(), isPendingMfaExpired: jest.fn(() => false),
    isUserMfaEnabled: jest.fn(async () => mfa), verifyTotpToken: jest.fn(), verifyUserMfaCode,
    verifyUserTotpToken: jest.fn()
  }));
  jest.doMock('../../src/services/emailService', () => ({
    sendVerificationEmail: jest.fn(), verifyEmailToken: jest.fn(), verifyEmailCode: jest.fn(),
    resendVerificationEmail: jest.fn(), isEmailVerified: jest.fn()
  }));
  jest.doMock('../../src/middleware/authMiddleware', () => ({ protectRoute: (_req, _res, next) => next() }));
  jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({ authRateLimiter: (_req, _res, next) => next() }));
  jest.doMock('../../src/middleware/csrfMiddleware', () => ({
    csrfProtection: (_req, _res, next) => next(), validateCsrfToken: (_req, _res, next) => next()
  }));
  jest.doMock('../../src/utils/securityLogger', () => ({ logAuthenticationFailure: jest.fn() }));
  jest.doMock('../../src/db/connection', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
  jest.doMock('../../src/utils/validation', () => ({
    isValidEmail: jest.fn(() => true), validatePasswordStrength: jest.fn(() => ({ valid: true }))
  }));
  jest.doMock('../../src/utils/apiGuideGenerator', () => ({
    generateApiGuide: jest.fn(), generateDirectSetupScript: jest.fn(), generateMainCLIScript: jest.fn()
  }));
  jest.doMock('../../src/utils/encryptionHelper', () => ({ generateEncryptionSalt: jest.fn() }));
  jest.doMock('../../src/utils/modelCatalog', () => ({ getProviderModelCatalog: jest.fn().mockResolvedValue([]) }));
  jest.doMock('../../src/utils/agentStopUtils', () => ({ readPidFromFile: jest.fn(), terminateProcessWithEscalation: jest.fn() }));
  jest.doMock('../../src/services/agentRuntimeConfigService', () => ({
    DEFAULT_DASHBOARD_CONFIG: {}, loadAgentRuntimeState: jest.fn(), persistAgentRuntimeState: jest.fn(), syncRuntimeStateToFilesystem: jest.fn()
  }));
  jest.doMock('../../public/js/marble-generator', () => jest.fn());
  const pageRoutes = require('../../src/routes/pageRoutes');
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = session;
    res.locals.csrfToken = 'csrf';
    res.render = (_view, locals) => res.status(200).json(locals);
    next();
  });
  app.use(pageRoutes);
  return { app, session, createSession, validateCredentials, verifyUserMfaCode, google };
}

describe('MCP OAuth sign-in continuation', () => {
  afterEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  it('returns password sign-in to the server-stored authorization request', async () => {
    const context = buildApp();
    const res = await request(context.app).post('/login').send({ email: 'user@example.com', password: 'password' }).expect(302);
    expect(res.headers.location).toBe('/oauth/authorize?client_id=known&state=opaque');
    expect(context.createSession).toHaveBeenCalled();
    expect(context.session.mcpOAuthReturnTo).toBeUndefined();
  });

  it('returns after MFA and does not take a redirect target from the browser form', async () => {
    const context = buildApp({ mfa: true });
    await request(context.app).post('/login').send({ email: 'user@example.com', password: 'password' }).expect(302).expect('Location', '/login/2fa');
    expect(context.session.pendingMfa.userId).toBe('user-1');
    const res = await request(context.app).post('/login/2fa').send({ code: '123456', returnTo: 'https://evil.example' }).expect(302);
    expect(res.headers.location).toBe('/oauth/authorize?client_id=known&state=opaque');
    expect(context.session.mcpOAuthReturnTo).toBeUndefined();
  });

  it('returns the OAuth continuation as JSON for the browser sign-in form', async () => {
    const context = buildApp();
    const res = await request(context.app).post('/login').set('Accept', 'application/json')
      .send({ email: 'user@example.com', password: 'password', returnTo: 'https://evil.example' }).expect(200);
    expect(res.body).toEqual({ redirectTo: '/oauth/authorize?client_id=known&state=opaque' });
    expect(context.session.mcpOAuthReturnTo).toBeUndefined();
  });

  it('directs browser sign-in to MFA before continuing OAuth', async () => {
    const context = buildApp({ mfa: true });
    const res = await request(context.app).post('/login').set('Accept', 'application/json')
      .send({ email: 'user@example.com', password: 'password' }).expect(200);
    expect(res.body).toEqual({ redirectTo: '/login/2fa' });
    expect(context.session.userId).toBeUndefined();
    expect(context.session.mcpOAuthReturnTo).toBe('/oauth/authorize?client_id=known&state=opaque');
  });

  it('keeps ordinary browser sign-in directed to the dashboard', async () => {
    const context = buildApp();
    delete context.session.mcpOAuthReturnTo;
    const res = await request(context.app).post('/login').set('Accept', 'application/json')
      .send({ email: 'user@example.com', password: 'password' }).expect(200);
    expect(res.body).toEqual({ redirectTo: '/dashboard' });
  });

  it('returns Google sign-in to the server-stored authorization request', async () => {
    const context = buildApp();
    const res = await request(context.app).get('/auth/google/callback').expect(302);
    expect(res.headers.location).toBe('/oauth/authorize?client_id=known&state=opaque');
  });
});
