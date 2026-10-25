ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent';
CREATE TABLE media_artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), asset_id TEXT REFERENCES assets(id), snapshot_id TEXT REFERENCES appearance_snapshots(id), provenance TEXT NOT NULL, ocr_regions TEXT, created_at TEXT NOT NULL);
CREATE TABLE client_ops (user_id TEXT NOT NULL REFERENCES users(id), client_op_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), day TEXT NOT NULL, daily_limit INTEGER NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(user_id,client_op_id));
CREATE INDEX client_ops_daily ON client_ops(user_id,day);
CREATE TRIGGER client_ops_daily_limit BEFORE INSERT ON client_ops
WHEN (SELECT COUNT(*) FROM client_ops WHERE user_id=NEW.user_id AND day=NEW.day)>=NEW.daily_limit
BEGIN
  SELECT RAISE(ABORT, 'client_ops_quota');
END;
