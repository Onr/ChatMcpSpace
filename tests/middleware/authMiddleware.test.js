const { 
  requireSession, 
  attachUserFromSession, 
  requireApiKey, 
  requireEmailVerification,
  resetAuthSuccessLogThrottle
} = require('../../src/middleware/authMiddleware');

const { getUserByApiKey } = require('../../src/services/authService');
const { logApiKeyUsage } = require('../../src/utils/securityLogger');
const { query } = require('../../src/db/connection');

// Mock dependencies
jest.mock('../../src/services/authService');
jest.mock('../../src/services/emailService');
jest.mock('../../src/utils/securityLogger');
jest.mock('../../src/db/connection');
jest.mock('../../src/services/agentCredentialService');

describe('scoped agent config reads', () => {
  const { verifyScopedCredential } = require('../../src/services/agentCredentialService');
  test.each([
    ['Native Agent', ['agent.responses.read'], true],
    ['Other Agent', ['agent.responses.read'], false],
    ['Native Agent', ['agent.messages.write'], false]
  ])('config request for %s with %j has access=%s', async (agentName, scopes, allowed) => {
    verifyScopedCredential.mockResolvedValue({ agentName: 'Native Agent', agentId: 'agent-id',
      credentialId: 'credential-id', user: { userId: 'owner-id' }, scopes });
    query.mockResolvedValue({ rows: [] });
    const req = { method: 'GET', path: '/config', query: { agentName }, body: {},
      headers: { 'x-agent-token': 'test-only' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn();
    await requireApiKey(req, res, next);
    if (allowed) expect(next).toHaveBeenCalledTimes(1);
    else { expect(next).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(403); }
  });
  test.each([
    ['GET', '/brief', 'agent.responses.read'],
    ['POST', '/brief/wake/claim', 'agent.responses.read'],
    ['POST', '/brief/wake/11111111-1111-4111-8111-111111111111/outcome', 'agent.responses.read'],
    ['POST', '/brief/suggestions', 'agent.messages.write']
  ])('%s %s requires %s', async (method, path, scope) => {
    verifyScopedCredential.mockResolvedValue({ agentName: 'Native Agent', agentId: 'agent-id', credentialId: 'credential-id', user: { userId: 'owner-id' }, scopes: [scope] });
    query.mockResolvedValue({ rows: [] });
    const req = { method, path, query: { agentName: 'Native Agent' }, body: { agentName: 'Native Agent' }, headers: { 'x-agent-token': 'test-only' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn();
    await requireApiKey(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('scoped auth event logging throttle', () => {
  const { verifyScopedCredential } = require('../../src/services/agentCredentialService');
  const authEventInserts = () => query.mock.calls.filter(([sql]) => /INSERT INTO agent_auth_events/.test(sql));
  const authEventTypes = () => authEventInserts().map(([, params]) => params[2]);

  async function authenticate({ credentialId = 'credential-id', scopes = ['agent.responses.read'], path = '/responses' } = {}) {
    verifyScopedCredential.mockResolvedValue({ agentName: 'Native Agent', agentId: 'agent-id',
      credentialId, user: { userId: 'owner-id' }, scopes });
    const req = { method: 'GET', path, query: { agentName: 'Native Agent' }, body: {},
      headers: { 'x-agent-token': 'test-only' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn();
    await requireApiKey(req, res, next);
    return { res, next };
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-28T12:00:00Z') });
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    resetAuthSuccessLogThrottle();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('records the first successful auth for a credential', async () => {
    const { next } = await authenticate();
    expect(next).toHaveBeenCalledTimes(1);
    expect(authEventTypes()).toEqual(['auth_success']);
  });

  it('skips repeat successes within ten minutes but still authenticates them', async () => {
    await authenticate();
    jest.advanceTimersByTime(9 * 60 * 1000);
    const { next } = await authenticate();
    expect(next).toHaveBeenCalledTimes(1);
    expect(authEventTypes()).toEqual(['auth_success']);
  });

  it('records another success once the window has passed', async () => {
    await authenticate();
    jest.advanceTimersByTime(10 * 60 * 1000);
    await authenticate();
    expect(authEventTypes()).toEqual(['auth_success', 'auth_success']);
  });

  it('records the first success of a rotated credential immediately for the handshake check', async () => {
    await authenticate({ credentialId: 'old-credential' });
    await authenticate({ credentialId: 'new-credential' });
    expect(authEventInserts().map(([, params]) => params[1])).toEqual(['old-credential', 'new-credential']);
  });

  it('always records scope denials', async () => {
    await authenticate();
    const first = await authenticate({ scopes: [], path: '/responses' });
    const second = await authenticate({ scopes: [], path: '/responses' });
    expect(first.res.status).toHaveBeenCalledWith(403);
    expect(second.res.status).toHaveBeenCalledWith(403);
    expect(authEventTypes()).toEqual(['auth_success', 'auth_scope_denied', 'auth_scope_denied']);
  });
});

describe('Auth Middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      session: {},
      headers: {},
      path: '/'
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      redirect: jest.fn(),
      locals: {}
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  describe('requireSession', () => {
    it('should call next if session and userId exist', () => {
      req.session.userId = 'user123';
      requireSession(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.redirect).not.toHaveBeenCalled();
    });

    it('should redirect to root if no session', () => {
      requireSession(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/');
    });

    it('should redirect to root if session exists but no userId', () => {
      req.session = { otherData: 'foo' };
      requireSession(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/');
    });
  });

  describe('attachUserFromSession', () => {
    it('should return 401 if no session/userId', async () => {
      await attachUserFromSession(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'AUTH_MISSING_CREDENTIALS' })
      }));
      expect(next).not.toHaveBeenCalled();
    });

    it('should attach user and call next if user found', async () => {
      req.session.userId = 'user123';
      query.mockResolvedValue({
        rows: [{ user_id: 'user123', email: 'test@example.com', email_verified: true }]
      });

      await attachUserFromSession(req, res, next);

      expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT user_id, email, email_verified FROM users WHERE user_id = $1'), ['user123']);
      expect(req.user).toEqual({
        userId: 'user123',
        email: 'test@example.com',
        emailVerified: true
      });
      expect(res.locals.emailVerified).toBe(true);
      expect(next).toHaveBeenCalled();
    });

    it('should handle legacy schema without email_verified column', async () => {
      req.session.userId = 'user123';
      // First call fails with column error
      query.mockRejectedValueOnce({ code: '42703' }); 
      // Second call succeeds with fallback query
      query.mockResolvedValueOnce({
        rows: [{ user_id: 'user123', email: 'test@example.com' }]
      });

      await attachUserFromSession(req, res, next);

      expect(query).toHaveBeenCalledTimes(2);
      expect(req.user).toEqual({
        userId: 'user123',
        email: 'test@example.com',
        emailVerified: false
      });
      expect(next).toHaveBeenCalled();
    });

    it('should destroy session and return 401 if user not found in DB', async () => {
      req.session.userId = 'user123';
      req.session.destroy = jest.fn();
      query.mockResolvedValue({ rows: [] });

      await attachUserFromSession(req, res, next);

      expect(req.session.destroy).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'AUTH_USER_NOT_FOUND' })
      }));
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 500 on DB error', async () => {
      req.session.userId = 'user123';
      query.mockRejectedValue(new Error('DB connection failed'));

      await attachUserFromSession(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' })
      }));
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireApiKey', () => {
    it('should call next and log usage for valid API key', async () => {
      req.headers['x-api-key'] = 'valid-key';
      const mockUser = { userId: 'user123', username: 'testuser' };
      getUserByApiKey.mockResolvedValue(mockUser);

      await requireApiKey(req, res, next);

      expect(getUserByApiKey).toHaveBeenCalledWith('valid-key');
      expect(req.user).toBe(mockUser);
      expect(logApiKeyUsage).toHaveBeenCalledWith(req, 'user123', 'API request authenticated');
      expect(next).toHaveBeenCalled();
    });

    it('should return 401 if API key is missing', async () => {
      await requireApiKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'AUTH_MISSING_CREDENTIALS' })
      }));
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if API key is invalid', async () => {
      req.headers['x-api-key'] = 'invalid-key';
      getUserByApiKey.mockResolvedValue(null);

      await requireApiKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'AUTH_INVALID_API_KEY' })
      }));
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 500 if service throws error', async () => {
      req.headers['x-api-key'] = 'valid-key';
      getUserByApiKey.mockRejectedValue(new Error('Service error'));

      await requireApiKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' })
      }));
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireEmailVerification', () => {
    it('should return 401 if user is not attached', () => {
      requireEmailVerification(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next if email is verified', () => {
      req.user = { emailVerified: true };
      requireEmailVerification(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should redirect to verify page for browser requests if not verified', () => {
      req.user = { emailVerified: false };
      requireEmailVerification(req, res, next);
      expect(res.redirect).toHaveBeenCalledWith('/verify-email-sent');
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 json for API requests if not verified', () => {
      req.user = { emailVerified: false };
      req.path = '/api/some-action';
      requireEmailVerification(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'EMAIL_NOT_VERIFIED' })
      }));
      expect(next).not.toHaveBeenCalled();
    });
  });
});
