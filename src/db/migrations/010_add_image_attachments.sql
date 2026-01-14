-- Migration: Add image attachments support
-- This creates tables for storing encrypted image attachments and linking them to messages

-- Create storage_provider enum type if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'storage_provider_enum') THEN
    CREATE TYPE storage_provider_enum AS ENUM ('local', 's3');
  END IF;
END $$;

-- Create uploaded_by enum type if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'uploaded_by_enum') THEN
    CREATE TYPE uploaded_by_enum AS ENUM ('user', 'agent');
  END IF;
END $$;

-- Create attachments table
CREATE TABLE IF NOT EXISTS attachments (
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

-- Create message_attachments join table (for agent messages)
CREATE TABLE IF NOT EXISTS message_attachments (
  message_id UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  attachment_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, attachment_id)
);

-- Create user_message_attachments join table (for user messages)
CREATE TABLE IF NOT EXISTS user_message_attachments (
  user_message_id UUID NOT NULL REFERENCES user_messages(user_message_id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  attachment_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_message_id, attachment_id)
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_attachments_agent_id ON attachments(agent_id);
CREATE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments(sha256);
CREATE INDEX IF NOT EXISTS idx_attachments_created_at ON attachments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_user_message_attachments_user_message_id ON user_message_attachments(user_message_id);

-- Add comments to document the tables and columns
COMMENT ON TABLE attachments IS 'Stores encrypted file/image attachments for E2E encrypted messaging';
COMMENT ON COLUMN attachments.attachment_id IS 'Unique identifier for the attachment';
COMMENT ON COLUMN attachments.content_type IS 'MIME type (e.g., image/png, image/jpeg)';
COMMENT ON COLUMN attachments.file_name IS 'Original filename (optional, may be null for privacy)';
COMMENT ON COLUMN attachments.size_bytes IS 'Size of the encrypted file in bytes';
COMMENT ON COLUMN attachments.sha256 IS 'SHA-256 hash for deduplication and integrity verification';
COMMENT ON COLUMN attachments.storage_provider IS 'Where the file is stored: local filesystem or S3';
COMMENT ON COLUMN attachments.storage_key IS 'Path or key to locate the file in storage';
COMMENT ON COLUMN attachments.encrypted IS 'TRUE if content is E2E encrypted (should always be TRUE)';
COMMENT ON COLUMN attachments.width IS 'Image width in pixels (for images only)';
COMMENT ON COLUMN attachments.height IS 'Image height in pixels (for images only)';
COMMENT ON COLUMN attachments.iv_base64 IS 'Base64-encoded initialization vector for AES-GCM decryption';
COMMENT ON COLUMN attachments.auth_tag_base64 IS 'Base64-encoded authentication tag for AES-GCM decryption';
COMMENT ON COLUMN attachments.agent_id IS 'The agent this attachment belongs to';
COMMENT ON COLUMN attachments.uploaded_by IS 'Who uploaded the attachment: user or agent';
COMMENT ON COLUMN attachments.created_at IS 'Timestamp when attachment was uploaded';

COMMENT ON TABLE message_attachments IS 'Links attachments to agent messages (many-to-many)';
COMMENT ON COLUMN message_attachments.attachment_order IS 'Display order of attachments within a message';

COMMENT ON TABLE user_message_attachments IS 'Links attachments to user messages (many-to-many)';
COMMENT ON COLUMN user_message_attachments.attachment_order IS 'Display order of attachments within a message';
