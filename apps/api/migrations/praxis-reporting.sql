CREATE TABLE IF NOT EXISTS praxis_transactions (
  transaction_id text PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  step_id text,
  operation_id text NOT NULL,
  schema_version integer NOT NULL,
  runtime_version text NOT NULL,
  phase text NOT NULL,
  outcome text,
  result jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT praxis_transactions_terminal_result CHECK ((completed_at IS NULL AND result IS NULL) OR (completed_at IS NOT NULL AND result IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS praxis_transactions_run_idx ON praxis_transactions(run_id, started_at, transaction_id);
CREATE INDEX IF NOT EXISTS praxis_transactions_attempt_step_idx ON praxis_transactions(attempt_id, step_id, started_at);

CREATE TABLE IF NOT EXISTS praxis_quality_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id text NOT NULL REFERENCES praxis_transactions(transaction_id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id text,
  intent_digest text NOT NULL,
  finding jsonb NOT NULL,
  artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transaction_id, intent_digest, finding)
);

CREATE INDEX IF NOT EXISTS praxis_quality_findings_run_idx ON praxis_quality_findings(run_id, created_at, id);
