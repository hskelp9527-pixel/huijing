-- Existing code limited each operation batch to 500, but had no project-wide ceiling.
CREATE TRIGGER project_canvas_limit BEFORE UPDATE OF canvas ON projects
WHEN json_array_length(NEW.canvas,'$.elements')>5000
  AND json_array_length(NEW.canvas,'$.elements')>json_array_length(OLD.canvas,'$.elements')
BEGIN
  SELECT RAISE(ABORT, 'project_canvas_limit');
END;
