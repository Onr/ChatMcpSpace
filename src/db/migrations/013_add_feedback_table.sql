-- Migration: Add feedback table for anonymous user feedback
-- Feedback is completely anonymous (no user_id stored) to encourage honest feedback
-- PRIVACY NOTE: user_agent was intentionally removed to ensure true anonymity.
-- Storing user_agent alongside page_url and created_at enables browser fingerprinting
-- that could potentially identify users, contradicting the anonymity promise.

CREATE TABLE IF NOT EXISTS feedback (
  feedback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message TEXT,                           -- Nullable for love-only feedback
  kind VARCHAR(20) NOT NULL DEFAULT 'feedback' CHECK (kind IN ('feedback', 'love')),
  page_url TEXT,
  -- user_agent intentionally omitted for privacy (enables browser fingerprinting)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for querying recent feedback
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);

-- Add comment to document the table
COMMENT ON TABLE feedback IS 'Anonymous user feedback - no user_id stored to ensure true anonymity';
