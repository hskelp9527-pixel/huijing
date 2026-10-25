-- The parent consumes each child result exactly once, even if it crashes before saving pending calls.
ALTER TABLE child_runs ADD COLUMN reported INTEGER NOT NULL DEFAULT 0 CHECK(reported IN (0,1));
