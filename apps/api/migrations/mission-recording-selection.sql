CREATE TABLE IF NOT EXISTS mission_recording_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  source_mission_revision integer NOT NULL CHECK (source_mission_revision >= 0),
  selected_by_agent_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  FOREIGN KEY (selected_by_agent_session_id, mission_id)
    REFERENCES agent_sessions(id, mission_id) ON DELETE RESTRICT,
  UNIQUE (mission_id, revision),
  UNIQUE (id, mission_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS mission_recording_selections_active_idx
  ON mission_recording_selections(mission_id)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS mission_recording_selections_revision_idx
  ON mission_recording_selections(mission_id, revision DESC);

CREATE TABLE IF NOT EXISTS mission_recording_selection_runs (
  selection_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  run_id uuid NOT NULL,
  run_order integer NOT NULL CHECK (run_order >= 0),

  PRIMARY KEY (selection_id, run_order),
  UNIQUE (selection_id, run_id),

  FOREIGN KEY (selection_id, mission_id)
    REFERENCES mission_recording_selections(id, mission_id)
    ON DELETE CASCADE,

  FOREIGN KEY (run_id, mission_id, objective_id)
    REFERENCES runs(id, mission_id, objective_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS mission_recording_selection_runs_order_idx
  ON mission_recording_selection_runs(selection_id, run_order);

CREATE INDEX IF NOT EXISTS mission_recording_selection_runs_run_idx
  ON mission_recording_selection_runs(run_id);

CREATE OR REPLACE FUNCTION protect_mission_recording_selection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE'
     OR NEW.mission_id<>OLD.mission_id
     OR NEW.revision<>OLD.revision
     OR NEW.source_mission_revision<>OLD.source_mission_revision
     OR NEW.selected_by_agent_session_id<>OLD.selected_by_agent_session_id
     OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Mission recording selections are immutable except supersession';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS mission_recording_selections_immutable
  ON mission_recording_selections;

CREATE TRIGGER mission_recording_selections_immutable
  BEFORE UPDATE OR DELETE
  ON mission_recording_selections
  FOR EACH ROW
  EXECUTE FUNCTION protect_mission_recording_selection();

CREATE OR REPLACE FUNCTION protect_mission_recording_selection_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Mission recording selection Run membership is immutable';
END
$$;

DROP TRIGGER IF EXISTS mission_recording_selection_runs_immutable
  ON mission_recording_selection_runs;

CREATE TRIGGER mission_recording_selection_runs_immutable
  BEFORE UPDATE OR DELETE
  ON mission_recording_selection_runs
  FOR EACH ROW
  EXECUTE FUNCTION protect_mission_recording_selection_run();
