const crypto = require('crypto');

jest.mock('../../src/db/connection', () => ({
  query: jest.fn()
}));

const { query } = require('../../src/db/connection');
const mfaService = require('../../src/services/mfaService');

describe('mfaService', () => {
  const originalSessionSecret = process.env.SESSION_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SESSION_SECRET = 'test-session-secret';
  });

  afterAll(() => {
    process.env.SESSION_SECRET = originalSessionSecret;
  });

  test('generates RFC-compatible TOTP codes', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const code = mfaService.hotp(secret, 1);
    expect(code).toBe('287082');
  });

  test('verifies TOTP tokens within the allowed time window', () => {
    const secret = mfaService.generateTotpSecret();
    const nowMs = Date.now();
    const currentCounter = Math.floor(nowMs / 1000 / mfaService.TOTP_PERIOD_SECONDS);
    const code = mfaService.hotp(secret, currentCounter);

    expect(mfaService.verifyTotpToken(secret, code, { nowMs, window: 1 })).toBe(true);
    expect(mfaService.verifyTotpToken(secret, '000000', { nowMs, window: 1 })).toBe(false);
  });

  test('builds otpauth URLs for authenticator apps', () => {
    const url = mfaService.buildOtpAuthUrl({
      email: 'test@example.com',
      secret: 'ABC123SECRET'
    });

    expect(url).toContain('otpauth://totp/');
    expect(url).toContain('secret=ABC123SECRET');
    expect(url).toContain('issuer=ChatMCPSpace');
  });

  test('enables MFA by storing encrypted secret material', async () => {
    await mfaService.enableUserTotp('user-1', 'ABCDEFGHIJKLMNOP');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_mfa'),
      [
        'user-1',
        expect.any(String),
        expect.any(String),
        expect.any(String)
      ]
    );
  });

  test('creates ten high-entropy, copyable recovery codes', () => {
    const codes = mfaService.generateRecoveryCodes();

    expect(codes).toHaveLength(mfaService.RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}(?:-[A-HJKMNP-Z2-9]{4}){3}$/);
    }
  });

  test('verifies a user token against decrypted stored secret', async () => {
    const secret = mfaService.generateTotpSecret();
    const iv = crypto.randomBytes(12);
    const key = crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const nowMs = Date.now();
    const code = mfaService.hotp(secret, Math.floor(nowMs / 1000 / mfaService.TOTP_PERIOD_SECONDS));

    query.mockResolvedValue({
      rows: [{
        user_id: 'user-1',
        enabled: true,
        totp_secret_encrypted: encrypted.toString('base64'),
        totp_secret_iv: iv.toString('base64'),
        totp_secret_auth_tag: authTag.toString('base64')
      }]
    });

    await expect(mfaService.verifyUserTotpToken('user-1', code, { nowMs })).resolves.toBe(true);
  });

  test('accepts a matching recovery code exactly once', async () => {
    query.mockResolvedValueOnce({ rows: [{
      user_id: 'user-1',
      enabled: true,
      totp_secret_encrypted: null,
      totp_secret_iv: null,
      totp_secret_auth_tag: null
    }] }).mockResolvedValueOnce({ rowCount: 1 });

    await expect(mfaService.verifyUserMfaCode('user-1', 'ABCD-EFGH-JKLM-NPQR')).resolves.toBe(true);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('DELETE FROM user_mfa_recovery_codes'),
      ['user-1', expect.any(String)]
    );
  });
});
