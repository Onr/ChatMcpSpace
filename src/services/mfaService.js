const crypto = require('crypto');
const { query } = require('../db/connection');

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const DEFAULT_ISSUER = 'ChatMCPSpace';
const PENDING_MFA_TTL_MS = 10 * 60 * 1000;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_GROUPS = 4;
const RECOVERY_CODE_GROUP_LENGTH = 4;

function getMfaEncryptionKey() {
  const source = process.env.MFA_ENCRYPTION_KEY || process.env.SESSION_SECRET;

  if (!source) {
    throw new Error('MFA_ENCRYPTION_KEY or SESSION_SECRET is required for 2FA');
  }

  return crypto.createHash('sha256').update(String(source)).digest();
}

function normalizeToken(token) {
  return String(token || '').replace(/\s+/g, '').trim();
}

function base32Encode(buffer) {
  let bits = '';
  let output = '';

  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, '0');
  }

  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    output += BASE32_ALPHABET[parseInt(chunk, 2)];
  }

  return output;
}

function base32Decode(secret) {
  const normalized = String(secret || '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/[^A-Z2-7]/g, '');

  let bits = '';

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32 secret');
    }
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }

  return Buffer.from(bytes);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const characters = Array.from(
      crypto.randomBytes(RECOVERY_CODE_GROUPS * RECOVERY_CODE_GROUP_LENGTH),
      byte => RECOVERY_CODE_ALPHABET[byte % RECOVERY_CODE_ALPHABET.length]
    );
    const groups = [];
    for (let index = 0; index < characters.length; index += RECOVERY_CODE_GROUP_LENGTH) {
      groups.push(characters.slice(index, index + RECOVERY_CODE_GROUP_LENGTH).join(''));
    }
    return groups.join('-');
  });
}

function getCounterForTime(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  const high = Math.floor(counter / 0x100000000);
  const low = counter % 0x100000000;

  counterBuffer.writeUInt32BE(high, 0);
  counterBuffer.writeUInt32BE(low, 4);

  const digest = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) % (10 ** TOTP_DIGITS);

  return String(code).padStart(TOTP_DIGITS, '0');
}

function verifyTotpToken(secret, token, options = {}) {
  const normalizedToken = normalizeToken(token);

  if (!/^\d{6}$/.test(normalizedToken)) {
    return false;
  }

  const windowSize = Number.isInteger(options.window) ? options.window : 1;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const counter = getCounterForTime(nowMs);

  for (let offset = -windowSize; offset <= windowSize; offset += 1) {
    const candidate = hotp(secret, counter + offset);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalizedToken))) {
      return true;
    }
  }

  return false;
}

function buildOtpAuthUrl({ email, secret, issuer = DEFAULT_ISSUER }) {
  const label = `${issuer}:${email}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

function encryptSecret(secret) {
  const key = getMfaEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64')
  };
}

function decryptSecret(record) {
  if (!record?.totp_secret_encrypted || !record?.totp_secret_iv || !record?.totp_secret_auth_tag) {
    return null;
  }

  const key = getMfaEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.totp_secret_iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(record.totp_secret_auth_tag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(record.totp_secret_encrypted, 'base64')),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

async function getUserMfaRecord(userId) {
  const result = await query(
    `SELECT user_id, enabled, totp_secret_encrypted, totp_secret_iv, totp_secret_auth_tag, created_at, updated_at
     FROM user_mfa
     WHERE user_id = $1`,
    [userId]
  );

  return result.rows[0] || null;
}

async function isUserMfaEnabled(userId) {
  const record = await getUserMfaRecord(userId);
  return record?.enabled === true;
}

async function enableUserTotp(userId, secret) {
  const encrypted = encryptSecret(secret);
  const recoveryCodes = generateRecoveryCodes();
  await query(
    `INSERT INTO user_mfa (
        user_id,
        enabled,
        totp_secret_encrypted,
        totp_secret_iv,
        totp_secret_auth_tag,
        created_at,
        updated_at
      )
      VALUES ($1, TRUE, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET enabled = TRUE,
          totp_secret_encrypted = EXCLUDED.totp_secret_encrypted,
          totp_secret_iv = EXCLUDED.totp_secret_iv,
          totp_secret_auth_tag = EXCLUDED.totp_secret_auth_tag,
          updated_at = NOW()`,
    [userId, encrypted.encrypted, encrypted.iv, encrypted.authTag]
  );

  // Codes are only returned once, immediately after setup. Store only a
  // one-way digest so a database leak cannot reveal usable backup codes.
  await query('DELETE FROM user_mfa_recovery_codes WHERE user_id = $1', [userId]);
  await query(
    `INSERT INTO user_mfa_recovery_codes (user_id, code_hash)
     SELECT $1, UNNEST($2::text[])`,
    [userId, recoveryCodes.map(hashRecoveryCode)]
  );

  return recoveryCodes;
}

async function disableUserMfa(userId) {
  await query(
    `UPDATE user_mfa
     SET enabled = FALSE,
         totp_secret_encrypted = NULL,
         totp_secret_iv = NULL,
         totp_secret_auth_tag = NULL,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );
  await query('DELETE FROM user_mfa_recovery_codes WHERE user_id = $1', [userId]);
}

async function verifyUserTotpToken(userId, token, options = {}) {
  const record = await getUserMfaRecord(userId);
  if (!record || record.enabled !== true) {
    return false;
  }

  const secret = decryptSecret(record);
  if (!secret) {
    return false;
  }

  return verifyTotpToken(secret, token, options);
}

async function verifyUserMfaCode(userId, code, options = {}) {
  if (await verifyUserTotpToken(userId, code, options)) {
    return true;
  }

  const normalized = normalizeRecoveryCode(code);
  if (!/^[A-Z0-9]{16}$/.test(normalized)) {
    return false;
  }

  const result = await query(
    `DELETE FROM user_mfa_recovery_codes
     WHERE user_id = $1 AND code_hash = $2
     RETURNING code_id`,
    [userId, hashRecoveryCode(normalized)]
  );
  return result.rowCount === 1;
}

function isPendingMfaExpired(createdAt) {
  if (!createdAt) {
    return true;
  }

  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) {
    return true;
  }

  return (Date.now() - createdMs) > PENDING_MFA_TTL_MS;
}

module.exports = {
  DEFAULT_ISSUER,
  PENDING_MFA_TTL_MS,
  RECOVERY_CODE_COUNT,
  TOTP_PERIOD_SECONDS,
  buildOtpAuthUrl,
  disableUserMfa,
  enableUserTotp,
  generateRecoveryCodes,
  generateTotpSecret,
  getUserMfaRecord,
  hotp,
  isPendingMfaExpired,
  isUserMfaEnabled,
  verifyTotpToken,
  verifyUserMfaCode,
  verifyUserTotpToken
};
