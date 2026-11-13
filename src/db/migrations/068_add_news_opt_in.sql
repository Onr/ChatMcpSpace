-- Optional consent to receive project news emails. Off by default; set only by the user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS news_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS news_opt_in_at TIMESTAMP DEFAULT NULL;
