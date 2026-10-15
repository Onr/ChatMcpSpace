const { isPublicHttpsConfigured } = require('../../src/utils/publicHttps');

describe('isPublicHttpsConfigured', () => {
  test('recognizes direct TLS', () => {
    expect(isPublicHttpsConfigured({ httpsEnabled: true, baseUrl: 'http://localhost:3000' })).toBe(true);
  });

  test('recognizes HTTPS terminated by a public reverse proxy', () => {
    expect(isPublicHttpsConfigured({ httpsEnabled: false, baseUrl: 'https://chatmcp.space' })).toBe(true);
  });

  test.each(['', 'http://localhost:3000', 'not a URL'])('rejects non-HTTPS public URLs: %s', (baseUrl) => {
    expect(isPublicHttpsConfigured({ httpsEnabled: false, baseUrl })).toBe(false);
  });
});
