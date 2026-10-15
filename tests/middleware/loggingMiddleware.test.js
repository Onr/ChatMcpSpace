const { safeRequestPath } = require('../../src/middleware/loggingMiddleware');

describe('request log path redaction', () => {
  it('removes authorization query values from OAuth URLs while preserving ordinary URLs', () => {
    expect(safeRequestPath({ originalUrl: '/oauth/authorize?state=secret&code_challenge=secret' }))
      .toBe('/oauth/authorize');
    expect(safeRequestPath({ originalUrl: '/oauth/callback?code=secret&state=secret' }))
      .toBe('/oauth/callback');
    expect(safeRequestPath({ originalUrl: '/dashboard?agentId=public-id' }))
      .toBe('/dashboard?agentId=public-id');
  });
});
