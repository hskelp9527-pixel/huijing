ALTER TABLE tasks ADD COLUMN provider_retry_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN provider_wait_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN provider_retry_at INTEGER;
ALTER TABLE tasks ADD COLUMN provider_no_image_retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_reservations ADD COLUMN set_admission_id TEXT;
CREATE INDEX quota_reservations_admission ON quota_reservations(set_admission_id);
