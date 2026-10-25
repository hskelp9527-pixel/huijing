CREATE TRIGGER asset_claim_once BEFORE UPDATE OF project_id ON assets
WHEN OLD.project_id IS NOT NULL AND NEW.project_id IS NOT OLD.project_id
BEGIN SELECT RAISE(ABORT, 'asset already claimed'); END;
CREATE TRIGGER snapshot_claim_once BEFORE UPDATE OF project_id ON appearance_snapshots
WHEN OLD.project_id IS NOT NULL AND NEW.project_id IS NOT OLD.project_id
BEGIN SELECT RAISE(ABORT, 'snapshot already claimed'); END;
