-- Admission records survive project cleanup, just like image quota reservations.
CREATE TABLE set_admissions (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  ip_subject TEXT NOT NULL,
  user_id TEXT NOT NULL
);
CREATE INDEX set_admissions_daily ON set_admissions(day,ip_subject);
ALTER TABLE image_sets ADD COLUMN single_regenerations INTEGER NOT NULL DEFAULT 0;
