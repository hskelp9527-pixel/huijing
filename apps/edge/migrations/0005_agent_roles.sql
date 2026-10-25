CREATE TABLE child_runs (id TEXT PRIMARY KEY, parent_run_id TEXT NOT NULL REFERENCES runs(id), project_id TEXT NOT NULL REFERENCES projects(id), role TEXT NOT NULL CHECK(role IN ('reference-review','concept','quality-review')), invocation_key TEXT NOT NULL, required INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','cancelled')), frozen_input TEXT NOT NULL, contents TEXT NOT NULL DEFAULT '[]', tool_count INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, output TEXT, error TEXT, UNIQUE(parent_run_id,invocation_key));
CREATE INDEX child_runs_parent ON child_runs(parent_run_id,state);
CREATE TRIGGER child_concurrency BEFORE INSERT ON child_runs
WHEN (SELECT COUNT(*) FROM child_runs WHERE parent_run_id=NEW.parent_run_id AND state IN ('queued','running'))>=2
BEGIN
  SELECT RAISE(ABORT, 'child_concurrency');
END;
ALTER TABLE runs ADD COLUMN quality_status TEXT NOT NULL DEFAULT 'unchecked';
ALTER TABLE runs ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN initiator_client_id TEXT;
ALTER TABLE input_requests ADD COLUMN resume_phase TEXT NOT NULL DEFAULT 'planning';
CREATE UNIQUE INDEX input_one_pending ON input_requests(run_id) WHERE state='pending';
