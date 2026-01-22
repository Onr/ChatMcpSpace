-- Migration: Add archive support for agents and messages
-- This enables users to archive agents and their messages while preserving important metadata
-- Archived data can be restored or permanently deleted later

-- Create archived_agents table
CREATE TABLE IF NOT EXISTS archived_agents (
  archived_agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  agent_name VARCHAR(255) NOT NULL,
  agent_type VARCHAR(20) NOT NULL CHECK (agent_type IN ('standard', 'news_feed')),
  total_messages INTEGER NOT NULL DEFAULT 0,
  archive_reason TEXT,
  archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create archived_messages table
CREATE TABLE IF NOT EXISTS archived_messages (
  archived_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  archived_agent_id UUID REFERENCES archived_agents(archived_agent_id) ON DELETE CASCADE,
  message_id UUID,
  user_message_id UUID,
  agent_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  message_type VARCHAR(20) NOT NULL CHECK (message_type IN ('agent_message', 'user_message')),
  content_snapshot TEXT,
  has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
  archive_note TEXT,
  archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Ensure exactly one of message_id or user_message_id is set
  CHECK (
    (message_id IS NOT NULL AND user_message_id IS NULL) OR
    (message_id IS NULL AND user_message_id IS NOT NULL)
  )
);

-- Add indexes for archived_agents
CREATE INDEX IF NOT EXISTS idx_archived_agents_user_id ON archived_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_archived_agents_archived_at ON archived_agents(archived_at DESC);

-- Add indexes for archived_messages
CREATE INDEX IF NOT EXISTS idx_archived_messages_user_id ON archived_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_archived_messages_archived_agent_id ON archived_messages(archived_agent_id);
CREATE INDEX IF NOT EXISTS idx_archived_messages_agent_id ON archived_messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_archived_messages_archived_at ON archived_messages(archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_archived_messages_message_id ON archived_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_archived_messages_user_message_id ON archived_messages(user_message_id);

-- Add comments to document the tables and columns
COMMENT ON TABLE archived_agents IS 'Stores metadata about archived agents - the actual agent records are deleted';
COMMENT ON COLUMN archived_agents.archived_agent_id IS 'Unique identifier for the archived agent record';
COMMENT ON COLUMN archived_agents.agent_id IS 'Original agent_id from the agents table (unique to prevent duplicate archives)';
COMMENT ON COLUMN archived_agents.user_id IS 'User who owned the agent';
COMMENT ON COLUMN archived_agents.agent_name IS 'Name of the agent at time of archival';
COMMENT ON COLUMN archived_agents.agent_type IS 'Type of agent: standard or news_feed';
COMMENT ON COLUMN archived_agents.total_messages IS 'Total count of messages (agent + user) that were archived';
COMMENT ON COLUMN archived_agents.archive_reason IS 'Optional reason provided by user for archiving';
COMMENT ON COLUMN archived_agents.archived_at IS 'Timestamp when agent was archived';

COMMENT ON TABLE archived_messages IS 'Stores snapshots of messages from archived agents';
COMMENT ON COLUMN archived_messages.archived_message_id IS 'Unique identifier for the archived message record';
COMMENT ON COLUMN archived_messages.archived_agent_id IS 'Reference to archived_agents table for cascade deletion';
COMMENT ON COLUMN archived_messages.message_id IS 'Original message_id from messages table (for agent messages)';
COMMENT ON COLUMN archived_messages.user_message_id IS 'Original user_message_id from user_messages table (for user messages)';
COMMENT ON COLUMN archived_messages.agent_id IS 'Agent this message belonged to (not a foreign key since agent may be deleted)';
COMMENT ON COLUMN archived_messages.user_id IS 'User who owned the agent';
COMMENT ON COLUMN archived_messages.message_type IS 'Type of message: agent_message or user_message';
COMMENT ON COLUMN archived_messages.content_snapshot IS 'Snapshot of message content at time of archival (may be encrypted)';
COMMENT ON COLUMN archived_messages.has_attachments IS 'Whether the message had attachments (attachment data is not preserved)';
COMMENT ON COLUMN archived_messages.archive_note IS 'Optional note about this archived message';
COMMENT ON COLUMN archived_messages.archived_at IS 'Timestamp when message was archived';
