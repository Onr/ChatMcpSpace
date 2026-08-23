-- Migration: Convert priority from VARCHAR to INTEGER
-- Priority values: 0 = all ok, 1 = needs attention, 2 = urgent

-- Remove the old constraint and column, add new integer column
ALTER TABLE messages 
  DROP CONSTRAINT IF EXISTS messages_priority_check;

-- Add a temporary column for the new integer priority
ALTER TABLE messages 
  ADD COLUMN priority_new INTEGER DEFAULT 0;

-- Migrate existing data
UPDATE messages SET priority_new = CASE
  WHEN priority = 'low' THEN 0
  WHEN priority = 'normal' THEN 0
  WHEN priority = 'high' THEN 2
  ELSE 0
END;

-- Drop old column and rename new one
ALTER TABLE messages DROP COLUMN priority;
ALTER TABLE messages RENAME COLUMN priority_new TO priority;

-- Add check constraint for valid priority values
ALTER TABLE messages 
  ADD CONSTRAINT messages_priority_check CHECK (priority IN (0, 1, 2));

-- Set NOT NULL constraint with default
ALTER TABLE messages 
  ALTER COLUMN priority SET DEFAULT 0,
  ALTER COLUMN priority SET NOT NULL;
