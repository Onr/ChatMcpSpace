-- Migration: Add stop_requested_at to agents for DB-level stop signaling
-- This allows stopping agents that don't have a local filesystem directory
-- (remote agents communicate stop via heartbeat checking this column)
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMP DEFAULT NULL;

COMMENT ON COLUMN agents.stop_requested_at IS 'When set, signals the agent to stop. Checked during heartbeat responses.';
