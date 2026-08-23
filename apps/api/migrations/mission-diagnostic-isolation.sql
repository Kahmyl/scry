-- Immutable Mission purpose and factual, append-only cross-Mission provenance.
ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'primary';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='missions_purpose_check'
  ) THEN
    ALTER TABLE missions ADD CONSTRAINT missions_purpose_check
      CHECK(purpose IN ('primary','diagnostic','recovery'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION protect_mission_purpose()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    RAISE EXCEPTION 'Mission purpose is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS missions_purpose_immutable ON missions;
CREATE TRIGGER missions_purpose_immutable
  BEFORE UPDATE OF purpose ON missions
  FOR EACH ROW EXECUTE FUNCTION protect_mission_purpose();

CREATE TABLE IF NOT EXISTS mission_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_mission_id uuid NOT NULL,
  target_mission_id uuid NOT NULL,
  relation text NOT NULL CHECK(relation IN ('diagnoses','recovery_for','informs')),
  created_by_agent_session_id uuid NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(source_mission_id,project_id)
    REFERENCES missions(id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY(target_mission_id,project_id)
    REFERENCES missions(id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY(created_by_agent_session_id,source_mission_id)
    REFERENCES agent_sessions(id,mission_id) ON DELETE RESTRICT,
  CHECK(source_mission_id<>target_mission_id),
  UNIQUE(source_mission_id,target_mission_id,relation)
);

CREATE INDEX IF NOT EXISTS mission_relations_source_idx
  ON mission_relations(source_mission_id,created_at,id);
CREATE INDEX IF NOT EXISTS mission_relations_target_idx
  ON mission_relations(target_mission_id,created_at,id);

DROP TRIGGER IF EXISTS mission_relations_immutable ON mission_relations;
CREATE TRIGGER mission_relations_immutable
  BEFORE UPDATE OR DELETE ON mission_relations
  FOR EACH ROW EXECUTE FUNCTION reject_mission_history_mutation();
