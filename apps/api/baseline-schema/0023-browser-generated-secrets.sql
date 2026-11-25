-- Native generated values have real command provenance, never fabricated
-- retained-adapter effects or user-input credential provenance.
ALTER TABLE protected_values DROP CONSTRAINT protected_values_source_kind_check;
ALTER TABLE protected_values ADD CONSTRAINT protected_values_source_kind_check
  CHECK (source_kind IN ('user_input','generated','browser_generated'));
ALTER TABLE browser_commands ADD CONSTRAINT browser_commands_identity_session UNIQUE(id,session_id);
ALTER TABLE browser_execution_sessions ADD CONSTRAINT browser_session_identity_environment UNIQUE(id,environment_id);
ALTER TABLE protected_values
  ADD COLUMN native_source_command_id uuid UNIQUE,
  ADD COLUMN native_source_session_id uuid,
  ADD COLUMN source_environment_id uuid,
  ADD COLUMN source_origin text,
  ADD COLUMN permitted_uses text[],
  ADD COLUMN source_owner_generation integer,
  ADD CONSTRAINT protected_native_command_fk FOREIGN KEY(native_source_command_id,native_source_session_id) REFERENCES browser_commands(id,session_id),
  ADD CONSTRAINT protected_native_scope_fk FOREIGN KEY(native_source_session_id,run_id,project_id,mission_id) REFERENCES browser_execution_sessions(id,run_id,project_id,mission_id),
  ADD CONSTRAINT protected_native_environment_fk FOREIGN KEY(native_source_session_id,source_environment_id) REFERENCES browser_execution_sessions(id,environment_id),
  ADD CONSTRAINT protected_native_owner_fk FOREIGN KEY(native_source_session_id,source_owner_generation) REFERENCES browser_owner_generations(session_id,generation),
  ADD CONSTRAINT protected_native_provenance CHECK (
    (source_kind='browser_generated' AND native_source_command_id IS NOT NULL AND native_source_session_id IS NOT NULL
      AND source_environment_id IS NOT NULL AND source_origin IS NOT NULL AND source_origin ~ '^https?://[^/]+$'
      AND source_owner_generation IS NOT NULL AND source_owner_generation>0 AND mission_id IS NOT NULL AND run_id IS NOT NULL AND expires_at IS NOT NULL
      AND permitted_uses IS NOT NULL AND cardinality(permitted_uses) BETWEEN 1 AND 3
      AND array_position(permitted_uses,NULL) IS NULL
      AND permitted_uses <@ ARRAY['browser_fill','scoped_request','hmac_verification']::text[])
    OR (source_kind<>'browser_generated' AND native_source_command_id IS NULL AND native_source_session_id IS NULL
      AND source_environment_id IS NULL AND source_origin IS NULL AND source_owner_generation IS NULL AND permitted_uses IS NULL)
  );
CREATE TABLE test_signature_verifications (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES test_resource_events(id),
  run_id uuid NOT NULL REFERENCES runs(id),
  protected_value_id uuid NOT NULL REFERENCES protected_values(id),
  idempotency_key text NOT NULL,
  input_digest text NOT NULL,
  safe_receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,idempotency_key)
);
