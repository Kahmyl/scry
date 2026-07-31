ALTER TABLE runs
  ADD COLUMN outcome_classification text,
  ADD COLUMN confirmation_of_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  ADD COLUMN confirmation_run_id uuid REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE artifacts
  ADD COLUMN observation jsonb;

UPDATE runs
SET outcome_classification = CASE state
  WHEN 'passed' THEN 'passed'
  WHEN 'failed' THEN 'inconclusive_plan'
  WHEN 'timed_out' THEN 'execution_timeout'
  WHEN 'infrastructure_error' THEN 'infrastructure_failure'
  WHEN 'cancelled' THEN 'cancelled'
  ELSE NULL
END;

ALTER TABLE runs
  ADD CONSTRAINT runs_outcome_classification_check CHECK (
    outcome_classification IS NULL OR outcome_classification IN (
      'passed', 'assertion_failure', 'readiness_timeout', 'transient_observation',
      'inconclusive_plan', 'confirmed_product_failure', 'non_reproduced_failure',
      'infrastructure_failure', 'policy_failure', 'execution_timeout', 'cancelled'
    )
  );

CREATE UNIQUE INDEX runs_confirmation_of_unique_idx
  ON runs(confirmation_of_run_id)
  WHERE confirmation_of_run_id IS NOT NULL;
