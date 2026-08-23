const {
  isLocalModeRequested,
  isLocalAuthMode,
  isGoogleAuthConfigured,
  resetLocalModeWarnings
} = require('../../src/utils/localMode');

describe('localMode', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LOCAL_MODE;
    delete process.env.NODE_ENV;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    resetLocalModeWarnings();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('isLocalModeRequested', () => {
    it('is off when the variable is unset', () => {
      expect(isLocalModeRequested()).toBe(false);
    });

    it.each(['true', 'TRUE', '1', 'yes', 'on', '  true  '])('accepts %p', (value) => {
      process.env.LOCAL_MODE = value;
      expect(isLocalModeRequested()).toBe(true);
    });

    it.each(['false', '0', 'no', '', 'maybe'])('rejects %p', (value) => {
      process.env.LOCAL_MODE = value;
      expect(isLocalModeRequested()).toBe(false);
    });
  });

  describe('isLocalAuthMode', () => {
    it('is off by default so the hosted flow is unchanged', () => {
      expect(isLocalAuthMode()).toBe(false);
    });

    it('is on when requested outside production', () => {
      process.env.LOCAL_MODE = 'true';
      process.env.NODE_ENV = 'development';
      expect(isLocalAuthMode()).toBe(true);
    });

    it('is on when NODE_ENV is unset', () => {
      process.env.LOCAL_MODE = 'true';
      expect(isLocalAuthMode()).toBe(true);
    });

    it('is ignored under NODE_ENV=production', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      process.env.LOCAL_MODE = 'true';
      process.env.NODE_ENV = 'production';

      expect(isLocalAuthMode()).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('ignoring it'));

      consoleSpy.mockRestore();
    });

    it('logs the production override only once', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      process.env.LOCAL_MODE = 'true';
      process.env.NODE_ENV = 'production';

      isLocalAuthMode();
      isLocalAuthMode();
      isLocalAuthMode();

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      consoleSpy.mockRestore();
    });
  });

  describe('isGoogleAuthConfigured', () => {
    it('is false when credentials are absent', () => {
      expect(isGoogleAuthConfigured()).toBe(false);
    });

    it('is false when only one half is set', () => {
      process.env.GOOGLE_CLIENT_ID = 'client-id';
      expect(isGoogleAuthConfigured()).toBe(false);
    });

    it('is false for whitespace-only placeholders', () => {
      process.env.GOOGLE_CLIENT_ID = '   ';
      process.env.GOOGLE_CLIENT_SECRET = '   ';
      expect(isGoogleAuthConfigured()).toBe(false);
    });

    it('is true when both halves are set', () => {
      process.env.GOOGLE_CLIENT_ID = 'client-id';
      process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
      expect(isGoogleAuthConfigured()).toBe(true);
    });
  });
});
