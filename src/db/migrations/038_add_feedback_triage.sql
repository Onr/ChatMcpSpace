-- Track internal review of anonymous feedback without recording any user identity.
-- The existing feedback payload remains anonymous; these fields only record the
-- outcome of product triage.
ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS triage_status VARCHAR(20) NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS triage_note TEXT,
  ADD COLUMN IF NOT EXISTS triaged_at TIMESTAMP;

ALTER TABLE feedback
  DROP CONSTRAINT IF EXISTS feedback_triage_status_check;

ALTER TABLE feedback
  ADD CONSTRAINT feedback_triage_status_check
  CHECK (triage_status IN ('new', 'in_progress', 'resolved', 'not_relevant'));

CREATE INDEX IF NOT EXISTS idx_feedback_triage_status_created_at
  ON feedback(triage_status, created_at DESC);
