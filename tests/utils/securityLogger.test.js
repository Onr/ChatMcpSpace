const {
  hashEmail,
  logAuthenticationFailure,
  logApiKeyUsage,
  logUnauthorizedAccess
} = require('../../src/utils/securityLogger');

describe('securityLogger', () => {
  const req = {
    ip: '203.0.113.9',
    connection: { remoteAddress: '203.0.113.9' },
    headers: { 'user-agent': 'jest' },
    path: '/api/user/messages',
    method: 'POST',
    user: { userId: 'user-1', email: 'Person@Example.com' }
  };

  let warnSpy;
  let logSpy;

  beforeEach(() => {
    delete process.env.SECURITY_LOG_API_KEY_USAGE;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    delete process.env.SECURITY_LOG_API_KEY_USAGE;
  });

  it('hashes emails consistently without preserving case', () => {
    expect(hashEmail('Person@Example.com')).toBe(hashEmail('person@example.com'));
    expect(hashEmail('person@example.com')).toMatch(/^[a-f0-9]{16}$/);
  });

  it('does not log raw email addresses for authentication failures', () => {
    logAuthenticationFailure(req, 'Person@Example.com', 'invalid password');

    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain('Person@Example.com');
    expect(loggedText).toContain(hashEmail('Person@Example.com'));
  });

  it('does not log raw user emails for unauthorized access', () => {
    logUnauthorizedAccess(req, 'message', 'message-1', 'wrong user');

    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain('Person@Example.com');
    expect(loggedText).toContain(hashEmail('Person@Example.com'));
  });

  it('suppresses high-volume API key usage logs by default', () => {
    logApiKeyUsage(req, 'user-1', 'API request authenticated');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('allows API key usage logs when explicitly enabled', () => {
    process.env.SECURITY_LOG_API_KEY_USAGE = 'true';

    logApiKeyUsage(req, 'user-1', 'API request authenticated');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('[API] API key usage');
  });
});
