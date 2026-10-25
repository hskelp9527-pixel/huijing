CREATE TABLE image_sets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  thread_id TEXT NOT NULL REFERENCES threads(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  template_id TEXT NOT NULL,
  template TEXT NOT NULL,
  source_asset_ids TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('analyzing','generating','completed','partial','failed')),
  analysis TEXT,
  supplied_points TEXT,
  analysis_started_at INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX image_sets_project ON image_sets(project_id,state);
CREATE TABLE set_shots (
  set_id TEXT NOT NULL REFERENCES image_sets(id),
  shot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  frame_element_id TEXT NOT NULL,
  image_element_id TEXT,
  text_element_ids TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(set_id,shot_id)
);
CREATE UNIQUE INDEX set_shots_task ON set_shots(task_id);
ALTER TABLE quota_reservations ADD COLUMN reserved_at INTEGER NOT NULL DEFAULT 0;
