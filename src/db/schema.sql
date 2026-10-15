-- AI Agent Messaging Platform Database Schema

-- Drop tables if they exist (for clean reinstall)
DROP TABLE IF EXISTS user_message_attachments CASCADE;
DROP TABLE IF EXISTS message_attachments CASCADE;
DROP TABLE IF EXISTS attachments CASCADE;
DROP TABLE IF EXISTS agent_auth_events CASCADE;
DROP TABLE IF EXISTS agent_api_credentials CASCADE;
DROP TABLE IF EXISTS external_agent_pairing_codes CASCADE;
DROP TABLE IF EXISTS external_bot_connections CASCADE;
DROP TABLE IF EXISTS email_logs CASCADE;
DROP TABLE IF EXISTS email_verification_tokens CASCADE;
DROP TABLE IF EXISTS user_mfa CASCADE;
DROP TABLE IF EXISTS user_responses CASCADE;
DROP TABLE IF EXISTS question_options CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS user_messages CASCADE;
DROP TABLE IF EXISTS feedback CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS migrations CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Drop custom enum types if they exist
DROP TYPE IF EXISTS storage_provider_enum CASCADE;
DROP TYPE IF EXISTS uploaded_by_enum CASCADE;

-- Users table
CREATE TABLE users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  google_id VARCHAR(255) UNIQUE,
  api_key VARCHAR(255) UNIQUE NOT NULL,
  script_token VARCHAR(64) UNIQUE NOT NULL,
  encryption_salt VARCHAR(255) NOT NULL, -- User-specific salt for E2E encryption (never used for decryption by server)
  email_verified BOOLEAN DEFAULT FALSE,
  email_verified_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_mfa (
  user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  totp_secret_encrypted TEXT,
  totp_secret_iv VARCHAR(64),
  totp_secret_auth_tag VARCHAR(64),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_mfa_recovery_codes (
  code_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, code_hash)
);

CREATE INDEX idx_user_mfa_recovery_codes_user_id ON user_mfa_recovery_codes(user_id);

-- Keep track of migrations that have been manually applied
CREATE TABLE migrations (
  migration_name TEXT PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Agents table
CREATE TABLE agents (
  agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  agent_name VARCHAR(255) NOT NULL,
  agent_type VARCHAR(20) DEFAULT 'standard' CHECK (agent_type IN ('standard', 'news_feed')),
  position INTEGER NOT NULL,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_working BOOLEAN NOT NULL DEFAULT FALSE,
  last_working_heartbeat_at TIMESTAMP,
  reported_cli_version VARCHAR(32),
  reported_cli_version_at TIMESTAMP,
  stop_requested_at TIMESTAMP DEFAULT NULL,
  runtime_config JSONB DEFAULT '{}'::jsonb,
  allowed_permissions JSONB DEFAULT '{}'::jsonb,
  is_chief_of_staff BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, agent_name)
);

-- Multiple named Chief of Staff agents are allowed per user; UNIQUE(user_id, agent_name)
-- keeps each local CoS distinguishable by name.

-- Messages table
CREATE TABLE messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  message_type VARCHAR(50) NOT NULL CHECK (message_type IN ('message', 'question')),
  content TEXT, -- Nullable: allows messages with only attachments
  encrypted BOOLEAN DEFAULT FALSE,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1, 2)),
  urgent BOOLEAN DEFAULT FALSE,
  allow_free_response BOOLEAN DEFAULT FALSE,
  free_response_hint TEXT,
  run_command VARCHAR(500) DEFAULT NULL,
  -- A client-generated UUID makes message delivery safe to retry after an
  -- ambiguous network failure without displaying the same reply twice.
  client_message_id UUID DEFAULT NULL,
  read_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Question options table
CREATE TABLE question_options (
  option_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  option_text TEXT NOT NULL,
  benefits TEXT,
  downsides TEXT,
  is_default BOOLEAN DEFAULT FALSE,
  option_order INTEGER NOT NULL
);

-- User responses table
CREATE TABLE user_responses (
  response_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  option_id UUID REFERENCES question_options(option_id) ON DELETE CASCADE,
  free_response TEXT,
  read_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id)
);

-- User messages table (free-text replies from users)
CREATE TABLE user_messages (
  user_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  content TEXT, -- Nullable: allows messages with only attachments
  encrypted BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMP DEFAULT NULL,
  run_overrides JSONB DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Enum types for attachments
CREATE TYPE storage_provider_enum AS ENUM ('local', 's3');
CREATE TYPE uploaded_by_enum AS ENUM ('user', 'agent');

-- Attachments table (for E2E encrypted image/file attachments)
CREATE TABLE attachments (
  attachment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type VARCHAR(100) NOT NULL,
  file_name VARCHAR(255),
  size_bytes BIGINT NOT NULL,
  sha256 VARCHAR(64),
  storage_provider storage_provider_enum NOT NULL DEFAULT 'local',
  storage_key VARCHAR(512) NOT NULL,
  encrypted BOOLEAN NOT NULL DEFAULT TRUE,
  width INTEGER,
  height INTEGER,
  iv_base64 VARCHAR(32),
  auth_tag_base64 VARCHAR(32),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  uploaded_by uploaded_by_enum NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Message attachments join table (for agent messages)
CREATE TABLE message_attachments (
  message_id UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  attachment_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, attachment_id)
);

-- User message attachments join table (for user messages)
CREATE TABLE user_message_attachments (
  user_message_id UUID NOT NULL REFERENCES user_messages(user_message_id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  attachment_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_message_id, attachment_id)
);

-- Indexes for performance optimization
CREATE INDEX idx_agents_user_id ON agents(user_id);
CREATE INDEX idx_agents_user_position ON agents(user_id, position);
CREATE INDEX idx_agents_is_working ON agents(is_working);
CREATE INDEX idx_agents_last_working_heartbeat_at ON agents(last_working_heartbeat_at DESC);
CREATE INDEX idx_messages_agent_id ON messages(agent_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX idx_question_options_message_id ON question_options(message_id);
CREATE INDEX idx_user_responses_message_id ON user_responses(message_id);
CREATE INDEX idx_user_messages_agent_id ON user_messages(agent_id);
CREATE INDEX idx_user_messages_created_at ON user_messages(created_at DESC);
CREATE INDEX idx_messages_read_at ON messages(read_at);
CREATE INDEX idx_user_messages_read_at ON user_messages(read_at);
CREATE INDEX idx_user_responses_read_at ON user_responses(read_at);
CREATE INDEX idx_users_api_key ON users(api_key);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_google_id ON users(google_id);
CREATE INDEX idx_users_script_token ON users(script_token);
CREATE INDEX idx_users_email_verified ON users(email_verified);
CREATE INDEX idx_user_mfa_enabled ON user_mfa(enabled);
CREATE INDEX idx_messages_encrypted ON messages(encrypted);
CREATE INDEX idx_user_messages_encrypted ON user_messages(encrypted);

-- Attachment indexes
CREATE INDEX idx_attachments_agent_id ON attachments(agent_id);
CREATE INDEX idx_attachments_sha256 ON attachments(sha256);
CREATE INDEX idx_attachments_created_at ON attachments(created_at DESC);
CREATE INDEX idx_message_attachments_message_id ON message_attachments(message_id);
CREATE INDEX idx_user_message_attachments_user_message_id ON user_message_attachments(user_message_id);

-- Feedback table (anonymous user feedback - no user_id for true anonymity)
-- PRIVACY NOTE: user_agent intentionally omitted to ensure true anonymity.
-- Storing user_agent alongside page_url and created_at enables browser fingerprinting
-- that could potentially identify users, contradicting the anonymity promise.
CREATE TABLE feedback (
  feedback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message TEXT,                           -- Nullable for love-only feedback
  kind VARCHAR(20) NOT NULL DEFAULT 'feedback' CHECK (kind IN ('feedback', 'love')),
  page_url TEXT,
  image_data BYTEA,
  image_content_type VARCHAR(100),
  image_filename VARCHAR(200),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  triage_status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (triage_status IN ('new', 'in_progress', 'resolved', 'not_relevant')),
  triage_note TEXT,
  triaged_at TIMESTAMP
);

CREATE UNIQUE INDEX idx_messages_agent_client_message_id
  ON messages(agent_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE INDEX idx_feedback_created_at ON feedback(created_at DESC);
CREATE INDEX idx_feedback_triage_status_created_at ON feedback(triage_status, created_at DESC);

-- External bot connection registry (e.g., OpenClaw BYOB)
CREATE TABLE external_bot_connections (
  connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  provider_bot_ref VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'pending_setup',
  last_handshake_at TIMESTAMP,
  last_error_code VARCHAR(100),
  last_error_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_id),
  UNIQUE (user_id, provider, provider_bot_ref)
);

-- Scoped per-agent auth credentials
CREATE TABLE agent_api_credentials (
  credential_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  token_prefix VARCHAR(24) NOT NULL,
  scopes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMP,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  rotated_from UUID REFERENCES agent_api_credentials(credential_id) ON DELETE SET NULL
);

-- Auth event audit log for agent tokens
CREATE TABLE agent_auth_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  credential_id UUID REFERENCES agent_api_credentials(credential_id) ON DELETE SET NULL,
  event_type VARCHAR(50) NOT NULL,
  ip_hash VARCHAR(128),
  user_agent_hash VARCHAR(128),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_external_bot_connections_user_id ON external_bot_connections(user_id);
CREATE INDEX idx_external_bot_connections_provider ON external_bot_connections(provider);
CREATE INDEX idx_external_bot_connections_status ON external_bot_connections(status);

-- Short-lived single-use approval codes for agent-started external setup.
CREATE TABLE external_agent_pairing_codes (
  pairing_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  requested_agent_name VARCHAR(255) NOT NULL,
  provider_bot_ref VARCHAR(255),
  inter_agent_mode VARCHAR(50) NOT NULL DEFAULT 'groups',
  group_names_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  can_spawn BOOLEAN NOT NULL DEFAULT FALSE,
  pairing_code_hash VARCHAR(128) NOT NULL UNIQUE,
  display_code_prefix VARCHAR(12) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  redeemed_at TIMESTAMP,
  redeemed_agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL,
  connection_id UUID REFERENCES external_bot_connections(connection_id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_external_agent_pairing_codes_user_id ON external_agent_pairing_codes(user_id);
CREATE INDEX idx_external_agent_pairing_codes_expires_at ON external_agent_pairing_codes(expires_at);
CREATE INDEX idx_external_agent_pairing_codes_redeemed_at ON external_agent_pairing_codes(redeemed_at);

CREATE INDEX idx_agent_api_credentials_agent_id ON agent_api_credentials(agent_id);
CREATE INDEX idx_agent_api_credentials_active ON agent_api_credentials(agent_id, revoked_at, expires_at);
CREATE INDEX idx_agent_auth_events_agent_id ON agent_auth_events(agent_id);
CREATE INDEX idx_agent_auth_events_type ON agent_auth_events(event_type);
CREATE INDEX idx_agent_auth_events_created_at ON agent_auth_events(created_at DESC);

-- Email verification tokens
CREATE TABLE email_verification_tokens (
  token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token VARCHAR(64) UNIQUE NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Email send audit logs
CREATE TABLE email_logs (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  email_to VARCHAR(255) NOT NULL,
  email_from VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  email_type VARCHAR(50) NOT NULL CHECK (email_type IN ('verification', 'password_reset', 'notification', 'welcome', 'other')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'bounced', 'delivered')),
  message_id VARCHAR(255),
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);
CREATE INDEX idx_email_verification_tokens_token ON email_verification_tokens(token);
CREATE INDEX idx_email_verification_tokens_expires_at ON email_verification_tokens(expires_at);
CREATE INDEX idx_email_logs_user_id ON email_logs(user_id);
CREATE INDEX idx_email_logs_email_to ON email_logs(email_to);
CREATE INDEX idx_email_logs_email_type ON email_logs(email_type);
CREATE INDEX idx_email_logs_status ON email_logs(status);
CREATE INDEX idx_email_logs_created_at ON email_logs(created_at DESC);
