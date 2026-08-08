CREATE TABLE IF NOT EXISTS execution_kernel_operations (
  session_id text NOT NULL,
  operation_id text NOT NULL,
  correlation_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('observe','rehearse','transact','certify','run')),
  capability_manifest_digest text NOT NULL CHECK (capability_manifest_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key text,
  state text NOT NULL CHECK (state IN ('admitted','completed','failed')),
  functional_result text CHECK (functional_result IN ('succeeded','failed','inconclusive')),
  mutation_outcome text CHECK (mutation_outcome IN ('not_applied','applied','unknown')),
  privacy_result text CHECK (privacy_result IN ('verified','unverified','degraded','sealed')),
  reason_code text,
  safe_outcome jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (session_id, operation_id),
  UNIQUE (session_id, idempotency_key)
);

ALTER TABLE authoring_browser_leases
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='authoring_runtime_commands_type_check'
      AND conrelid='authoring_runtime_commands'::regclass
  ) THEN
    ALTER TABLE authoring_runtime_commands
      DROP CONSTRAINT authoring_runtime_commands_type_check;
  END IF;
  ALTER TABLE authoring_runtime_commands
    ADD CONSTRAINT authoring_runtime_commands_type_check
    CHECK (type IN (
      'observe_document','interact','advance_turn','suspend','resume','cancel'
    ));
END $$;

CREATE TABLE IF NOT EXISTS execution_kernel_events (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL,
  operation_id text NOT NULL,
  sequence integer NOT NULL,
  phase text NOT NULL,
  safe_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, operation_id, sequence),
  FOREIGN KEY (session_id, operation_id)
    REFERENCES execution_kernel_operations(session_id, operation_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS execution_kernel_mutations (
  session_id text NOT NULL,
  operation_id text NOT NULL,
  mutation_kind text NOT NULL CHECK (mutation_kind IN ('one_time','repeatable')),
  program_digest text NOT NULL,
  input_schema_digest text NOT NULL,
  input_digest text NOT NULL,
  state text NOT NULL CHECK (state IN (
    'planned','dispatch_authorized','dispatching','dispatched','acknowledged',
    'reconciled_succeeded','reconciled_not_applied','outcome_unknown'
  )),
  fencing_token integer NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, operation_id)
);

CREATE TABLE IF NOT EXISTS execution_kernel_checkpoints (
  session_id text NOT NULL,
  checkpoint_id text NOT NULL,
  binding_fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('verified','failed','destroyed')),
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (session_id, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS execution_kernel_secret_values (
  id uuid PRIMARY KEY,
  session_id text NOT NULL,
  operation_id text NOT NULL,
  reference text NOT NULL,
  name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('run','project')),
  ciphertext bytea NOT NULL,
  initialization_vector bytea NOT NULL,
  authentication_tag bytea NOT NULL,
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, reference)
);
ALTER TABLE execution_kernel_secret_values
  ADD COLUMN IF NOT EXISTS retention_until timestamptz;

CREATE TABLE IF NOT EXISTS execution_kernel_public_values (
  id uuid PRIMARY KEY,
  session_id text NOT NULL,
  operation_id text NOT NULL,
  reference text NOT NULL,
  name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('run','project')),
  value text NOT NULL,
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, reference)
);
ALTER TABLE execution_kernel_public_values
  ADD COLUMN IF NOT EXISTS retention_until timestamptz;

CREATE TABLE IF NOT EXISTS execution_kernel_context_provenance (
  session_id text NOT NULL,
  context_id text NOT NULL,
  operation_id text NOT NULL,
  provenance text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, context_id, operation_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS execution_kernel_operations_correlation_idx
  ON execution_kernel_operations(correlation_id);
CREATE INDEX IF NOT EXISTS execution_kernel_events_session_idx
  ON execution_kernel_events(session_id, operation_id, sequence);
CREATE INDEX IF NOT EXISTS execution_kernel_mutations_state_idx
  ON execution_kernel_mutations(state, updated_at);
CREATE INDEX IF NOT EXISTS execution_kernel_secret_retention_idx
  ON execution_kernel_secret_values(retention_until)
  WHERE scope='run' AND retention_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS execution_kernel_public_retention_idx
  ON execution_kernel_public_values(retention_until)
  WHERE scope='run' AND retention_until IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_execution_kernel_terminal_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Execution kernel operations are append-only';
  END IF;
  IF OLD.state IN ('completed','failed') THEN
    RAISE EXCEPTION 'Execution kernel terminal operations are immutable';
  END IF;
  IF NEW.session_id<>OLD.session_id OR NEW.operation_id<>OLD.operation_id
     OR NEW.correlation_id<>OLD.correlation_id OR NEW.mode<>OLD.mode
     OR NEW.capability_manifest_digest<>OLD.capability_manifest_digest
     OR NEW.request_digest<>OLD.request_digest
     OR NEW.started_at<>OLD.started_at THEN
    RAISE EXCEPTION 'Execution kernel operation identity is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS execution_kernel_terminal_immutable ON execution_kernel_operations;
CREATE TRIGGER execution_kernel_terminal_immutable
  BEFORE UPDATE OR DELETE ON execution_kernel_operations
  FOR EACH ROW EXECUTE FUNCTION protect_execution_kernel_terminal_operation();
