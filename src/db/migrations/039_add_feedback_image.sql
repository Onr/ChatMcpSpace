-- Optional anonymous feedback image. No submitting user ID is recorded.
ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS image_data BYTEA,
  ADD COLUMN IF NOT EXISTS image_content_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS image_filename VARCHAR(200);
