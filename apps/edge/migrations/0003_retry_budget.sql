ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN waiting_since INTEGER;
ALTER TABLE tasks ADD COLUMN retry_of_task_id TEXT REFERENCES tasks(id);
