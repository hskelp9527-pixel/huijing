-- M5: retain legacy tables and data; registered identities cannot become guests.
ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0 CHECK(is_guest IN (0,1));
ALTER TABLE projects ADD COLUMN last_accessed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
UPDATE projects SET last_accessed_at=updated_at;
CREATE INDEX projects_last_accessed ON projects(last_accessed_at);
