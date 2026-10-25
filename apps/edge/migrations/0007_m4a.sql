ALTER TABLE threads ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;
CREATE INDEX events_run ON events(project_id, json_extract(data, '$.runId'), seq);
CREATE INDEX events_thread_created ON events(project_id, json_extract(data, '$.payload.thread.id')) WHERE json_extract(data, '$.type')='thread.created';
CREATE INDEX events_message_created ON events(project_id, json_extract(data, '$.payload.messageId')) WHERE json_extract(data, '$.type')='message.created';
