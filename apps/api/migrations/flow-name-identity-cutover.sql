-- Flow IDs and immutable Mission ownership are authoritative identity. A Flow
-- name is a human-readable label and must not reserve hidden Project-wide
-- authority across independently owned Mission-local Flows.
ALTER TABLE flows
  DROP CONSTRAINT IF EXISTS flows_project_id_name_key;

CREATE INDEX IF NOT EXISTS flows_project_name_idx
  ON flows(project_id,name);
