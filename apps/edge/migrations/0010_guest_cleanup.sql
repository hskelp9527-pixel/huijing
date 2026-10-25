ALTER TABLE projects ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0,1));
CREATE TRIGGER project_initial_access AFTER INSERT ON projects
WHEN NEW.last_accessed_at='1970-01-01T00:00:00.000Z'
BEGIN
  UPDATE projects SET last_accessed_at=NEW.created_at WHERE id=NEW.id;
END;
