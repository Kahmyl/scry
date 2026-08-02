CREATE TABLE browser_contexts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  operation_id text,
  provenance text NOT NULL CHECK (provenance IN ('safe','safe_parked','protected','tainted','destroyed','restored_pending_verification','restored_safe')),
  capture_epoch integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  destroyed_at timestamptz,
  UNIQUE (run_id, id),
  CHECK ((provenance = 'destroyed') = (destroyed_at IS NOT NULL))
);

-- Immutable evidence provenance. Browser context state may later become parked or
-- destroyed; artifact admission is based on the closed epoch that produced bytes.
CREATE TABLE capture_epochs (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  context_id uuid NOT NULL REFERENCES browser_contexts(id) ON DELETE RESTRICT,
  epoch integer NOT NULL CHECK (epoch > 0),
  producing_provenance text NOT NULL CHECK (producing_provenance IN ('safe','restored_safe')),
  status text NOT NULL CHECK (status IN ('completed','sealed')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  PRIMARY KEY (context_id, epoch),
  UNIQUE (run_id, context_id, epoch)
);

CREATE TABLE protected_transactions (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('planned','acquisition_readiness_validating','acquisition_ready','safe_context_parking','safe_context_parked','capsule_bootstrapping','bootstrap_failed','capsule_ready','preparation_running','preparation_verified','preparation_failed','dispatch_authorized','mutation_dispatching','mutation_dispatched','acquisition_running','acquisition_unresolved','recovery_window','secure_assistance','revocation_running','credential_revoked','credential_abandoned','recovery_expired','capsule_destroying','capsule_destroyed','continuation_establishing','evidence_resumed','continuing_unrecorded','terminal','aborted')),
  mutation_kind text NOT NULL CHECK (mutation_kind IN ('one_time','repeatable')),
  program_digest text NOT NULL CHECK (program_digest ~ '^[a-f0-9]{64}$'),
  input_schema_digest text NOT NULL CHECK (input_schema_digest ~ '^[a-f0-9]{64}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  bootstrap_status text NOT NULL DEFAULT 'not_started' CHECK (bootstrap_status IN ('not_started','running','succeeded','failed','incomplete')),
  preparation_status text NOT NULL DEFAULT 'not_started' CHECK (preparation_status IN ('not_started','running','succeeded','failed','incomplete')),
  mutation_dispatch_status text NOT NULL DEFAULT 'not_started' CHECK (mutation_dispatch_status IN ('not_started','authorized','started','acknowledged')),
  mutation_outcome_status text NOT NULL DEFAULT 'not_attempted' CHECK (mutation_outcome_status IN ('not_attempted','confirmed_succeeded','confirmed_not_applied','unknown')),
  protected_extraction_status text NOT NULL DEFAULT 'not_attempted' CHECK (protected_extraction_status IN ('not_attempted','captured','not_found','failed')),
  public_extraction_status text NOT NULL DEFAULT 'not_attempted' CHECK (public_extraction_status IN ('not_attempted','captured','not_found','failed')),
  protected_persistence_status text NOT NULL DEFAULT 'not_attempted' CHECK (protected_persistence_status IN ('not_attempted','confirmed','uncertain','failed')),
  public_persistence_status text NOT NULL DEFAULT 'not_attempted' CHECK (public_persistence_status IN ('not_attempted','confirmed','uncertain','failed')),
  capsule_status text NOT NULL DEFAULT 'not_created' CHECK (capsule_status IN ('not_created','active','destroyed','force_terminated','destruction_failed')),
  reconciliation_status text NOT NULL DEFAULT 'not_configured' CHECK (reconciliation_status IN ('not_configured','succeeded','not_applied','unknown','failed')),
  continuation_status text NOT NULL DEFAULT 'not_attempted' CHECK (continuation_status IN ('not_attempted','parked_resumed','clean_recreated','reauthenticated','continuing_unrecorded','terminal','failed')),
  evidence_status text NOT NULL DEFAULT 'stopped' CHECK (evidence_status IN ('stopped','resumed','permanently_suppressed')),
  credential_security_status text NOT NULL DEFAULT 'none' CHECK (credential_security_status IN ('none','active','compromised','revoked','unusable')),
  safe_context_id uuid,
  protected_context_id uuid,
  fencing_token bigint NOT NULL DEFAULT 0,
  worker_lease_id text,
  lease_expires_at timestamptz,
  reason_code text,
  failure_phase text CHECK (failure_phase IN ('bootstrap','preparation','mutation_dispatch','mutation_reconciliation','extraction','acquisition','recovery','persistence','capsule_destruction','continuation')),
  retry_class text CHECK (retry_class IN ('safe_to_retry','retry_requires_reconciliation','do_not_retry','manual_review')),
  acquisition_contract_digest text CHECK(acquisition_contract_digest IS NULL OR acquisition_contract_digest ~ '^[a-f0-9]{64}$'),
  recovery_expires_at timestamptz,
  recovery_lease_id uuid,
  recovery_resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, operation_id)
);

CREATE TABLE protected_mutation_ledger (
  run_id uuid NOT NULL,
  operation_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('planned','dispatch_authorized','dispatching','dispatched','acknowledged','reconciled_succeeded','reconciled_not_applied','outcome_unknown')),
  fencing_token bigint NOT NULL,
  worker_lease_id text,
  lease_expires_at timestamptz,
  invocation_started_at timestamptz,
  invocation_acknowledged_at timestamptz,
  public_mutation_reference text,
  reconciliation_status text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, operation_id),
  FOREIGN KEY (run_id, operation_id) REFERENCES protected_transactions(run_id, operation_id) ON DELETE CASCADE
);

ALTER TABLE artifacts ADD COLUMN context_id uuid REFERENCES browser_contexts(id) ON DELETE RESTRICT;
ALTER TABLE artifacts ADD COLUMN capture_epoch integer;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_capture_epoch_fk
  FOREIGN KEY (context_id, capture_epoch) REFERENCES capture_epochs(context_id, epoch) ON DELETE RESTRICT;
ALTER TABLE artifact_timeline_entries ADD COLUMN context_id uuid REFERENCES browser_contexts(id) ON DELETE RESTRICT;
ALTER TABLE artifact_timeline_entries ADD COLUMN capture_epoch integer;

CREATE FUNCTION enforce_safe_artifact_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE epoch_provenance text;
BEGIN
  IF NEW.availability = 'available' THEN
    IF NEW.context_id IS NULL OR NEW.capture_epoch IS NULL THEN RAISE EXCEPTION 'AVAILABLE_ARTIFACT_REQUIRES_PROVENANCE'; END IF;
    SELECT producing_provenance INTO epoch_provenance
      FROM capture_epochs WHERE context_id = NEW.context_id AND epoch = NEW.capture_epoch AND status IN ('completed','sealed');
    IF epoch_provenance NOT IN ('safe','restored_safe') THEN RAISE EXCEPTION 'PROTECTED_CONTEXT_ARTIFACT_REJECTED'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER artifacts_safe_provenance BEFORE INSERT OR UPDATE OF availability, storage_key, context_id, capture_epoch ON artifacts FOR EACH ROW EXECUTE FUNCTION enforce_safe_artifact_provenance();

CREATE INDEX browser_contexts_run_idx ON browser_contexts(run_id, created_at);
CREATE INDEX protected_transactions_state_idx ON protected_transactions(lifecycle_state, lease_expires_at);
