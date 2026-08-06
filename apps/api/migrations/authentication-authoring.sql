CREATE TABLE IF NOT EXISTS authentication_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_session_id uuid NOT NULL REFERENCES probe_sessions(id) ON DELETE CASCADE,
  credential_reference_id uuid REFERENCES project_credentials(id) ON DELETE RESTRICT,
  submission_method text NOT NULL CHECK (submission_method IN ('click','press_enter','request')),
  dispatch_state text NOT NULL CHECK (dispatch_state IN ('created','dispatching','dispatched','uncertain','blocked')),
  dispatch_started_at timestamptz,
  mutation_boundary_observed boolean NOT NULL DEFAULT false,
  result_classification text CHECK (
    result_classification IS NULL OR
    result_classification IN ('submitted','blocked','uncertain_dispatch','already_dispatched')
  ),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (safe_metadata::text !~* '(password|token|clipboard|secret|authorization)')
);

CREATE INDEX IF NOT EXISTS authentication_attempts_probe_idx
  ON authentication_attempts(probe_session_id, created_at DESC);


CREATE INDEX IF NOT EXISTS authentication_attempts_dispatch_idx
  ON authentication_attempts(dispatch_state, created_at DESC);
