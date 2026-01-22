-- AI Agent Messaging Platform Database Schema

-- Drop tables if they exist (for clean reinstall)
DROP TABLE IF EXISTS user_message_attachments CASCADE;
DROP TABLE IF EXISTS message_attachments CASCADE;
DROP TABLE IF EXISTS attachments CASCADE;
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
  password_hash VARCHAR(255) NOT NULL,
  api_key VARCHAR(255) UNIQUE NOT NULL,
  encryption_salt VARCHAR(255) NOT NULL, -- User-specific salt for E2E encryption (never used for decryption by server)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, agent_name)
);

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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_feedback_created_at ON feedback(created_at DESC);
