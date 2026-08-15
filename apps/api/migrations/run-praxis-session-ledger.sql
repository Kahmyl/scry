CREATE TABLE IF NOT EXISTS run_praxis_sessions (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  praxis_session_id uuid NOT NULL REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  epoch integer NOT NULL CHECK (epoch > 0),
  attached_at timestamptz NOT NULL DEFAULT now(),
  detached_at timestamptz,
  idempotency_key text NOT NULL,
  PRIMARY KEY (run_id, epoch),
  UNIQUE (run_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS run_praxis_sessions_active_idx
  ON run_praxis_sessions(run_id) WHERE detached_at IS NULL;

CREATE TABLE IF NOT EXISTS run_operation_links (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  praxis_session_id uuid NOT NULL,
  operation_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  safe_result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, sequence),
  UNIQUE (run_id, operation_id),
  FOREIGN KEY (praxis_session_id, operation_id)
    REFERENCES adaptive_operations(session_id, operation_id) ON DELETE RESTRICT
);
