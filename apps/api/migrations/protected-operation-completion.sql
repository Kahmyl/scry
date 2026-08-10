ALTER TABLE run_captured_secrets
  DROP CONSTRAINT IF EXISTS run_captured_secrets_run_id_operation_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS run_captured_secrets_operation_reference_unique
  ON run_captured_secrets(run_id, operation_id, reference);
