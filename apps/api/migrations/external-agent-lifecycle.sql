ALTER TABLE agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_provider_check;

ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_provider_check
  CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS external_run_id uuid,
  ADD COLUMN IF NOT EXISTS experiment_id text,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS termination_reason text;

ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_model_check
  CHECK (model IS NULL OR (length(model) BETWEEN 1 AND 200)),
  ADD CONSTRAINT agent_sessions_experiment_id_check
  CHECK (experiment_id IS NULL OR (length(experiment_id) BETWEEN 1 AND 200)),
  ADD CONSTRAINT agent_sessions_termination_reason_check
  CHECK (termination_reason IS NULL OR termination_reason ~ '^[A-Z][A-Z0-9_]{0,119}$');

CREATE INDEX agent_sessions_external_run_idx
  ON agent_sessions(external_run_id)
  WHERE external_run_id IS NOT NULL;

CREATE INDEX agent_sessions_external_lease_idx
  ON agent_sessions(lease_expires_at)
  WHERE status='active' AND external_run_id IS NOT NULL;
