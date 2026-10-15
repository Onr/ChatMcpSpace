-- All guest file admissions share one transaction lock. Account uploads and
-- downloads retain their existing paths; no retained file is deleted here.
CREATE TABLE IF NOT EXISTS shared_guest_storage_guard (
    id INTEGER PRIMARY KEY CHECK (id = 1)
);
INSERT INTO shared_guest_storage_guard(id) VALUES(1) ON CONFLICT DO NOTHING;
