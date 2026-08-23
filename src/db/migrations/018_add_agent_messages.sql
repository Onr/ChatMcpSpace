-- Migration: 018_add_agent_messages.sql
-- Description: Add agent-to-agent messaging support
-- Date: 2026-01-29

-- Agent-to-Agent messages table
CREATE TABLE IF NOT EXISTS agent_messages (
    agent_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    recipient_agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    encrypted BOOLEAN DEFAULT FALSE,
    priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1, 2)),
    read_at TIMESTAMP DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Ensure sender and recipient are different
    CONSTRAINT different_agents CHECK (sender_agent_id != recipient_agent_id)
);

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_agent_messages_sender ON agent_messages(sender_agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_recipient ON agent_messages(recipient_agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_read_at ON agent_messages(read_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_created_at ON agent_messages(created_at DESC);

-- Composite index for polling: recipient + read status + time
CREATE INDEX IF NOT EXISTS idx_agent_messages_recipient_unread 
    ON agent_messages(recipient_agent_id, read_at, created_at DESC) 
    WHERE read_at IS NULL;
