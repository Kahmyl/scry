-- Additive receipts; old individual-command and lifecycle clients remain valid.
CREATE TABLE browser_journey_receipts (
  mission_id uuid NOT NULL REFERENCES missions(id),
  attempt_id text NOT NULL CHECK (length(attempt_id) BETWEEN 8 AND 128),
  project_id uuid NOT NULL REFERENCES projects(id),
  agent_session_id uuid NOT NULL REFERENCES agent_sessions(id),
  input_digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mission_id,attempt_id)
);
ALTER TABLE browser_journey_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON browser_journey_receipts FROM PUBLIC;

ALTER TABLE browser_execution_sessions ADD COLUMN stop_requested_at timestamptz;
ALTER TABLE browser_commands ADD COLUMN cancel_requested_at timestamptz;
