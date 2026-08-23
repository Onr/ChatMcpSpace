const fs = require('fs');
const path = require('path');

const {
  getMigrationFiles,
  MIGRATION_RENAMES,
} = require('../../src/db/runMigrations');

const migrationsDir = path.join(__dirname, '../../src/db/migrations');
const schemaSql = fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8');

describe('database migration ordering', () => {
  test('all SQL migrations have a numeric prefix and unique ordered prefix', () => {
    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'));

    const prefixes = new Set();
    for (const file of files) {
      const match = file.match(/^(\d+[a-z]?)_/i);
      expect(match).not.toBeNull();
      expect(prefixes.has(match[1])).toBe(false);
      prefixes.add(match[1]);
    }
  });

  test('renamed migrations keep aliases for existing databases', () => {
    for (const [currentName, previousNames] of Object.entries(MIGRATION_RENAMES)) {
      expect(fs.existsSync(path.join(migrationsDir, currentName))).toBe(true);
      expect(previousNames.length).toBeGreaterThan(0);
    }
  });

  test('migration runner sorts alpha-suffixed migrations deterministically', () => {
    const files = getMigrationFiles();
    expect(files).toContain('004a_priority_to_integer.sql');
    expect(files).toContain('004b_add_user_responses_read_tracking.sql');
    expect(files).toContain('006a_add_agent_type.sql');
    expect(files).toContain('006b_add_google_auth.sql');
    expect(files).toContain('024a_add_agent_working_heartbeat.sql');
    expect(files).toContain('024b_add_external_bot_connections.sql');
    expect(files).toContain('035_add_user_mfa.sql');
    expect(files).toContain('040_add_mfa_recovery_codes.sql');

    expect(files.indexOf('004a_priority_to_integer.sql'))
      .toBeLessThan(files.indexOf('004b_add_user_responses_read_tracking.sql'));
    expect(files.indexOf('006a_add_agent_type.sql'))
      .toBeLessThan(files.indexOf('006b_add_google_auth.sql'));
    expect(files.indexOf('024a_add_agent_working_heartbeat.sql'))
      .toBeLessThan(files.indexOf('024b_add_external_bot_connections.sql'));
    expect(files.indexOf('029_add_email_verification.sql'))
      .toBeGreaterThan(files.indexOf('028_add_agent_runtime_state.sql'));
  });
});

describe('schema.sql reviewed drift guards', () => {
  test('canonical users table includes OAuth, CLI token, and email verification columns', () => {
    expect(schemaSql).toContain('password_hash VARCHAR(255)');
    expect(schemaSql).toContain('google_id VARCHAR(255) UNIQUE');
    expect(schemaSql).toContain('script_token VARCHAR(64) UNIQUE NOT NULL');
    expect(schemaSql).toContain('email_verified BOOLEAN DEFAULT FALSE');
    expect(schemaSql).toContain('email_verified_at TIMESTAMP DEFAULT NULL');
  });

  test('canonical schema includes the optional user_mfa table', () => {
    expect(schemaSql).toContain('CREATE TABLE user_mfa');
    expect(schemaSql).toContain('totp_secret_encrypted TEXT');
    expect(schemaSql).toContain('CREATE INDEX idx_user_mfa_enabled ON user_mfa(enabled);');
  });

  test('canonical schema includes one-time MFA recovery codes', () => {
    expect(schemaSql).toContain('CREATE TABLE user_mfa_recovery_codes');
    expect(schemaSql).toContain('code_hash CHAR(64) NOT NULL');
  });

  test('canonical schema includes email verification tables and indexes', () => {
    expect(schemaSql).toContain('CREATE TABLE email_verification_tokens');
    expect(schemaSql).toContain('CREATE TABLE email_logs');
    expect(schemaSql).toContain('CREATE INDEX idx_email_verification_tokens_user_id');
    expect(schemaSql).toContain('CREATE INDEX idx_email_logs_created_at');
  });
});
