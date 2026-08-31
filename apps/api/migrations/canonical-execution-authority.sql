-- Canonical execution authority cutover.
-- Completion projects durable mutation truth for read-only and mutation paths alike.
CREATE OR REPLACE FUNCTION protect_adaptive_operation_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  durable protected_operations%ROWTYPE;
  durable_count integer;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Adaptive operations cannot be deleted';
  END IF;

  IF NEW.session_id<>OLD.session_id OR NEW.operation_id<>OLD.operation_id
     OR NEW.sequence<>OLD.sequence OR NEW.mode<>OLD.mode
     OR NEW.semantic_intent<>OLD.semantic_intent OR NEW.expected_effect<>OLD.expected_effect
     OR NEW.policy_digest<>OLD.policy_digest OR NEW.started_at<>OLD.started_at
     OR NEW.mission_id IS DISTINCT FROM OLD.mission_id
     OR NEW.objective_id IS DISTINCT FROM OLD.objective_id
     OR NEW.flow_draft_id IS DISTINCT FROM OLD.flow_draft_id
     OR NEW.authoring_intent IS DISTINCT FROM OLD.authoring_intent
     OR NEW.derived_action IS DISTINCT FROM OLD.derived_action
     OR NEW.idempotency_key<>OLD.idempotency_key
     OR NEW.observation_epoch IS DISTINCT FROM OLD.observation_epoch
     OR NEW.candidate_decision_digest IS DISTINCT FROM OLD.candidate_decision_digest
     OR (OLD.capability_manifest_digest IS NOT NULL AND
         NEW.capability_manifest_digest IS DISTINCT FROM OLD.capability_manifest_digest)
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'Adaptive operation identity is immutable';
  END IF;

  IF OLD.state NOT IN ('completed','failed') THEN
    RETURN NEW;
  END IF;

  IF OLD.semantic_intent->>'type'<>'protectedTransaction' THEN
    RAISE EXCEPTION 'Terminal adaptive operations are immutable';
  END IF;

  SELECT count(*),min(protected.id::text)::uuid
    INTO durable_count,durable.id
    FROM protected_operations protected
    JOIN adaptive_sessions session
      ON session.id=OLD.session_id
     AND session.environment_id=protected.environment_id
   WHERE protected.owner_kind='authoring_session'
     AND protected.authoring_session_id=OLD.session_id
     AND protected.operation_id=OLD.operation_id
     AND protected.mission_id=OLD.mission_id
     AND protected.objective_id=OLD.objective_id
     AND protected.flow_draft_id=OLD.flow_draft_id
     AND ((protected.authority_model='canonical' AND protected.prepared_execution_capability_id=
       NULLIF(OLD.authoring_intent->'authorization'->>'preparedExecutionCapabilityId','')::uuid)
       OR (protected.authority_model<>'canonical' AND protected.authorization_id=
       NULLIF(OLD.authoring_intent->'authorization'->>'authorizationId','')::uuid))
     AND protected.state IN ('completed','failed_not_applied','recovery_required','compromised','revoked','abandoned');

  IF durable_count<>1 THEN
    RAISE EXCEPTION 'Terminal adaptive protected projection requires one matching durable operation';
  END IF;

  SELECT * INTO STRICT durable FROM protected_operations WHERE id=durable.id FOR SHARE;

  IF NEW.capability_manifest_digest IS NULL
     OR NEW.evidence_result IS DISTINCT FROM '[]'::jsonb
     OR NEW.quality_findings IS DISTINCT FROM '[]'::jsonb
     OR NEW.safe_outcome IS NULL OR NEW.decision_boundary IS NULL
     OR NEW.safe_outcome->>'operationId'<>OLD.operation_id
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Terminal adaptive protected projection is not canonical';
  END IF;

  IF durable.state='completed' THEN
    IF NEW.state<>'completed' OR NEW.functional_result<>'succeeded'
       OR NEW.mutation_outcome IS DISTINCT FROM durable.mutation_outcome OR NEW.privacy_result<>'sealed'
       OR NEW.dispatch_boundary<>'acknowledged'
       OR NEW.safe_outcome->>'functionalResult'<>'succeeded'
       OR (NEW.safe_outcome->>'mutationOutcome') IS DISTINCT FROM durable.mutation_outcome
       OR NEW.safe_outcome->>'privacyResult'<>'sealed'
       OR NEW.decision_boundary->>'type'<>'objective_completed'
       OR jsonb_typeof(NEW.safe_outcome->'generatedReferences')<>'array'
       OR jsonb_array_length(NEW.safe_outcome->'generatedReferences')<>
          (SELECT count(*) FROM jsonb_object_keys(durable.persisted_references))
       OR EXISTS (
         SELECT 1 FROM jsonb_each(durable.persisted_references) stored(reference,value)
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(NEW.safe_outcome->'generatedReferences') projected
             WHERE projected->>'reference'=stored.reference
               AND projected->>'classification'=stored.value->>'classification'
               AND projected->>'scope'='project'
               AND (
                 (stored.value->>'classification'='protected' AND projected->>'credentialId'=stored.value->>'credentialId')
                 OR (stored.value->>'classification'='public' AND projected->>'valueId'=stored.value->>'valueId')
               )
          )
       ) THEN
      RAISE EXCEPTION 'Completed adaptive protected projection disagrees with durable operation';
    END IF;
  ELSIF durable.state='failed_not_applied' THEN
    IF NEW.state<>'failed' OR NEW.functional_result<>'failed'
       OR NEW.mutation_outcome<>'not_applied' OR NEW.privacy_result<>'sealed'
       OR NEW.safe_outcome->>'functionalResult'<>'failed'
       OR NEW.safe_outcome->>'mutationOutcome'<>'not_applied'
       OR NEW.decision_boundary->>'type' NOT IN ('environment_unavailable','policy_refused','ambiguous_candidate')
       OR NEW.safe_outcome ? 'generatedReferences' THEN
      RAISE EXCEPTION 'Failed adaptive protected projection disagrees with durable operation';
    END IF;
  ELSIF durable.mutation_outcome='applied' THEN
    IF NEW.state<>'failed' OR NEW.functional_result<>'inconclusive'
       OR NEW.mutation_outcome<>'applied' OR NEW.privacy_result<>'sealed'
       OR NEW.safe_outcome->>'functionalResult'<>'inconclusive'
       OR NEW.safe_outcome->>'mutationOutcome'<>'applied'
       OR NEW.decision_boundary->>'type'<>'effect_observation_required'
       OR jsonb_typeof(NEW.safe_outcome->'generatedReferences')<>'array'
       OR jsonb_array_length(NEW.safe_outcome->'generatedReferences')<>
          (SELECT count(*) FROM jsonb_object_keys(durable.persisted_references))
       OR EXISTS (
         SELECT 1 FROM jsonb_each(durable.persisted_references) stored(reference,value)
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(NEW.safe_outcome->'generatedReferences') projected
             WHERE projected->>'reference'=stored.reference
               AND projected->>'classification'=stored.value->>'classification'
               AND projected->>'scope'='project'
               AND (
                 (stored.value->>'classification'='protected' AND projected->>'credentialId'=stored.value->>'credentialId')
                 OR (stored.value->>'classification'='public' AND projected->>'valueId'=stored.value->>'valueId')
               )
          )
       ) THEN
      RAISE EXCEPTION 'Applied recovery adaptive protected projection disagrees with durable operation';
    END IF;
  ELSE
    IF NEW.state<>'failed' OR NEW.functional_result<>'inconclusive'
       OR NEW.mutation_outcome<>'unknown' OR NEW.privacy_result<>'sealed'
       OR NEW.safe_outcome->>'functionalResult'<>'inconclusive'
       OR NEW.safe_outcome->>'mutationOutcome'<>'unknown'
       OR NEW.decision_boundary->>'type'<>'mutation_reconciliation_required'
       OR NEW.safe_outcome ? 'generatedReferences' THEN
      RAISE EXCEPTION 'Recovery adaptive protected projection disagrees with durable operation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

-- Historical prepared-operation rows remain evidence/reconciliation only. New dispatch authority
-- is issued exclusively through immutable semantic, interaction, policy, execution, and value grants.

-- This is a cold authority cutoff, not a rolling dual-authority migration. Stop/drain
-- old workers and browser owners first; uncertain history itself is never rewritten.
LOCK TABLE worker_heartbeats, adaptive_session_runtime_leases, protected_operations
  IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM worker_heartbeats WHERE heartbeat_at>now()-interval '30 seconds')
     OR EXISTS(SELECT 1 FROM adaptive_session_runtime_leases WHERE lease_expires_at>now())
     OR EXISTS(SELECT 1 FROM protected_operations WHERE lease_expires_at>now()
       AND state NOT IN ('completed','failed_not_applied','compromised','revoked','abandoned')) THEN
    RAISE EXCEPTION 'CANONICAL_AUTHORITY_CUTOVER_REQUIRES_DRAINED_WORKERS_AND_OWNERS';
  END IF;
END $$;

-- Forward reduction for installed, unreleased canonical schemas. Audit copies are
-- frozen, never read as execution authority. No effect counters or receipts change.
DO $$ BEGIN
  IF to_regclass('public.canonical_output_provenance') IS NOT NULL THEN
    LOCK TABLE typed_value_assets, canonical_output_provenance,
      prepared_execution_capabilities IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (
      SELECT 1 FROM canonical_output_provenance output
      FULL JOIN typed_value_assets asset ON asset.id=output.value_asset_id
      WHERE output.value_asset_id IS NULL OR asset.id IS NULL
        OR output.protected_operation_id<>asset.producer_protected_operation_id
        OR output.canonical_output_key<>asset.canonical_output_key
        OR output.operation_contract_revision_id<>asset.operation_contract_revision_id
        OR output.classification<>asset.classification
        OR output.identity_role IS DISTINCT FROM asset.identity_role
    ) THEN RAISE EXCEPTION 'THIN_KERNEL_HISTORICAL_PROVENANCE_MISMATCH'; END IF;
    ALTER TABLE typed_value_assets ADD COLUMN IF NOT EXISTS transport_extractor jsonb;
    ALTER TABLE typed_value_assets ADD COLUMN IF NOT EXISTS resource_effect jsonb;
    -- Only copy already recorded extraction facts. Never infer absent provenance.
    DROP TRIGGER IF EXISTS typed_value_assets_immutable ON typed_value_assets;
    UPDATE typed_value_assets asset SET transport_extractor=output.transport_extractor,
      resource_effect=output.resource_effect
      FROM canonical_output_provenance output WHERE output.value_asset_id=asset.id;
    ALTER TABLE canonical_output_provenance RENAME TO historical_canonical_output_provenance;
    COMMENT ON TABLE historical_canonical_output_provenance IS
      'Frozen pre-thin-kernel audit evidence. Not a provenance or execution authority.';
  END IF;
  IF to_regclass('public.mission_value_selections') IS NOT NULL THEN
    ALTER TABLE mission_value_selections RENAME TO historical_mission_value_selections;
    DROP TRIGGER IF EXISTS selected_value_consumer_revocation ON historical_mission_value_selections;
    DROP TRIGGER IF EXISTS mission_value_selections_immutable ON historical_mission_value_selections;
    CREATE TRIGGER historical_mission_value_selections_immutable BEFORE INSERT OR UPDATE OR DELETE
      ON historical_mission_value_selections FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();
    COMMENT ON TABLE historical_mission_value_selections IS
      'Frozen selection audit history; confers no authority on new execution.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='prepared_execution_capabilities' AND column_name='authorization_id') THEN
    CREATE TABLE historical_prepared_execution_approvals AS
      SELECT id AS prepared_execution_capability_id,authorization_id
      FROM prepared_execution_capabilities WHERE authorization_id IS NOT NULL;
    CREATE TRIGGER historical_prepared_execution_approvals_immutable BEFORE INSERT OR UPDATE OR DELETE
      ON historical_prepared_execution_approvals FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();
    ALTER TABLE prepared_execution_capabilities DROP COLUMN authorization_id;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS operation_contract_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  application_key text NOT NULL CHECK(application_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,99}$'),
  provider_key text CHECK(provider_key IS NULL OR provider_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,99}$'),
  adapter_key text NOT NULL CHECK(adapter_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,99}$'),
  adapter_version integer NOT NULL CHECK(adapter_version > 0),
  operation_key text NOT NULL CHECK(operation_key ~ '^[a-z][A-Za-z0-9]{0,99}$'),
  revision integer NOT NULL CHECK(revision > 0),
  facts jsonb NOT NULL,
  provenance jsonb NOT NULL,
  semantic_digest text NOT NULL CHECK(semantic_digest ~ '^[a-f0-9]{64}$'),
  retention_state text NOT NULL DEFAULT 'active'
    CHECK(retention_state IN ('active','superseded','retained','expired')),
  staleness text NOT NULL DEFAULT 'current'
    CHECK(staleness IN ('current','historical','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,application_key,operation_key,revision),
  UNIQUE(id,semantic_digest),
  UNIQUE(project_id,semantic_digest),
  CHECK(facts::text !~* '(plaintext|ciphertext|secret.?value|credential.?value|password.?value)'),
  CHECK(provenance::text !~* '(plaintext|ciphertext|secret.?value|credential.?value|password.?value)'),
  CHECK(NOT jsonb_path_exists(facts,'$.**.activationControlReference')),
  CHECK(NOT jsonb_path_exists(facts,'$.**.controlReference'))
);

CREATE TABLE IF NOT EXISTS operation_contract_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_contract_revision_id uuid NOT NULL REFERENCES operation_contract_revisions(id) ON DELETE RESTRICT,
  praxis_session_id uuid NOT NULL REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  observation_provenance jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_contract_revision_id,praxis_session_id),
  CHECK(observation_provenance::text !~* '(plaintext|ciphertext|secret.?value|credential.?value|password.?value)')
);

CREATE TABLE IF NOT EXISTS runtime_interaction_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_contract_revision_id uuid NOT NULL,
  operation_contract_revision_digest text NOT NULL,
  praxis_session_id uuid NOT NULL REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  runtime_owner_id uuid NOT NULL,
  fencing_epoch integer NOT NULL CHECK(fencing_epoch > 0),
  document_epoch integer NOT NULL CHECK(document_epoch >= 0),
  origin text NOT NULL CHECK(origin ~ '^https?://'),
  activation_control_reference text NOT NULL
    CHECK(activation_control_reference ~ '^context-control-[a-f0-9]{32}$'),
  input_control_references jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active'
    CHECK(state IN ('active','consumed','revoked','expired','stale')),
  revoked_at timestamptz,
  FOREIGN KEY(operation_contract_revision_id,operation_contract_revision_digest)
    REFERENCES operation_contract_revisions(id,semantic_digest) ON DELETE RESTRICT,
  UNIQUE(id,operation_contract_revision_id,operation_contract_revision_digest),
  CHECK(input_control_references::text !~* '(plaintext|ciphertext|secret.?value|credential.?value|password.?value)')
);
CREATE INDEX IF NOT EXISTS runtime_interaction_capabilities_live_idx
  ON runtime_interaction_capabilities(praxis_session_id,runtime_owner_id,fencing_epoch,expires_at)
  WHERE state='active';

CREATE TABLE IF NOT EXISTS execution_policy_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  application_key text NOT NULL CHECK(application_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,99}$'),
  policy_version integer NOT NULL CHECK(policy_version > 0),
  allowed_origins jsonb NOT NULL,
  trusted_script_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy jsonb NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,environment_id,application_key,digest),
  UNIQUE(id,digest),
  CHECK(jsonb_typeof(allowed_origins)='array'),
  CHECK(jsonb_typeof(trusted_script_origins)='array')
);

ALTER TABLE protected_operations
  ADD COLUMN IF NOT EXISTS authority_model text NOT NULL DEFAULT 'legacy'
    CHECK(authority_model IN ('legacy','canonical')),
  ADD COLUMN IF NOT EXISTS prepared_execution_capability_id uuid;

ALTER TABLE protected_operations
  DROP CONSTRAINT IF EXISTS protected_operations_program_digest_check;
ALTER TABLE protected_operations
  ADD CONSTRAINT protected_operations_program_digest_check CHECK(
    (state='reserved' AND program_digest IS NULL)
    OR (praxis_session_id IS NOT NULL AND state='planned' AND program_digest IS NULL)
    OR (authority_model='canonical' AND state IN ('abandoned','failed_not_applied')
      AND dispatch_state='not_started' AND program_digest IS NULL)
    OR (state NOT IN ('reserved') AND program_digest ~ '^[a-f0-9]{64}$')
  );

CREATE TABLE IF NOT EXISTS prepared_execution_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protected_operation_id uuid NOT NULL UNIQUE REFERENCES protected_operations(id) ON DELETE RESTRICT,
  mutation_identity uuid NOT NULL UNIQUE,
  operation_contract_revision_id uuid NOT NULL,
  operation_contract_revision_digest text NOT NULL,
  runtime_interaction_capability_id uuid NOT NULL,
  execution_policy_snapshot_id uuid NOT NULL,
  execution_policy_snapshot_digest text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  objective_id uuid NOT NULL,
  agent_session_id uuid NOT NULL,
  application_key text NOT NULL CHECK(application_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,99}$'),
  dispatch_semantics text NOT NULL CHECK(dispatch_semantics IN ('read_only','mutation')),
  effect_semantics text[] NOT NULL,
  target_commitment text NOT NULL CHECK(target_commitment ~ '^[a-f0-9]{64}$'),
  input_commitment text NOT NULL CHECK(input_commitment ~ '^[a-f0-9]{64}$'),
  output_commitment text NOT NULL CHECK(output_commitment ~ '^[a-f0-9]{64}$'),
  resource_effect jsonb,
  program_manifest jsonb,
  program_digest text CHECK(program_digest IS NULL OR program_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'reserved'
    CHECK(state IN ('reserved','finalized','invalidated','historical')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  FOREIGN KEY(operation_contract_revision_id,operation_contract_revision_digest)
    REFERENCES operation_contract_revisions(id,semantic_digest) ON DELETE RESTRICT,
  FOREIGN KEY(runtime_interaction_capability_id,operation_contract_revision_id,operation_contract_revision_digest)
    REFERENCES runtime_interaction_capabilities(id,operation_contract_revision_id,operation_contract_revision_digest)
    ON DELETE RESTRICT,
  FOREIGN KEY(execution_policy_snapshot_id,execution_policy_snapshot_digest)
    REFERENCES execution_policy_snapshots(id,digest) ON DELETE RESTRICT,
  FOREIGN KEY(objective_id,mission_id) REFERENCES mission_objectives(id,mission_id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_session_id,mission_id) REFERENCES agent_sessions(id,mission_id) ON DELETE RESTRICT,
  CHECK(cardinality(effect_semantics) BETWEEN 1 AND 4),
  CHECK((state='reserved' AND program_manifest IS NULL AND program_digest IS NULL AND finalized_at IS NULL)
    OR (state='finalized' AND program_manifest IS NOT NULL AND program_digest IS NOT NULL AND finalized_at IS NOT NULL)
    OR state IN ('invalidated','historical'))
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='protected_operations_prepared_capability_fk') THEN
    ALTER TABLE protected_operations ADD CONSTRAINT protected_operations_prepared_capability_fk
      FOREIGN KEY(prepared_execution_capability_id)
      REFERENCES prepared_execution_capabilities(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS protected_operations_prepared_capability_unique
  ON protected_operations(prepared_execution_capability_id)
  WHERE prepared_execution_capability_id IS NOT NULL;

-- Ownership shape is independent of historical approval rows. The deferred
-- constraint permits the operation/capability pair to be allocated atomically.
ALTER TABLE protected_operations DROP CONSTRAINT IF EXISTS protected_operations_owner_shape_check;
ALTER TABLE protected_operations ADD CONSTRAINT protected_operations_owner_shape_check CHECK(
  (owner_kind='authoring_session' AND authoring_session_id IS NOT NULL AND run_id IS NULL AND flow_draft_id IS NOT NULL)
  OR (owner_kind='run' AND run_id IS NOT NULL AND authoring_session_id IS NULL AND flow_revision_id IS NOT NULL)
);
CREATE OR REPLACE FUNCTION require_exact_prepared_execution_pair()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.authority_model='canonical' AND NOT EXISTS (
    SELECT 1 FROM protected_operations operation
    JOIN prepared_execution_capabilities capability ON capability.id=operation.prepared_execution_capability_id
     AND capability.protected_operation_id=operation.id
     AND capability.mutation_identity::text=operation.mutation_identity
     AND capability.project_id=operation.project_id AND capability.environment_id=operation.environment_id
     AND capability.mission_id=operation.mission_id AND capability.objective_id=operation.objective_id
     AND capability.agent_session_id=operation.agent_session_id
    WHERE operation.id=NEW.id
  ) THEN RAISE EXCEPTION 'CANONICAL_EXECUTION_PAIR_REQUIRED'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS canonical_execution_pair ON protected_operations;
CREATE CONSTRAINT TRIGGER canonical_execution_pair AFTER INSERT OR UPDATE ON protected_operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_exact_prepared_execution_pair();

ALTER TABLE run_operation_links ADD COLUMN IF NOT EXISTS prepared_execution_capability_id uuid
  REFERENCES prepared_execution_capabilities(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS run_operation_links_canonical_capability_unique
  ON run_operation_links(prepared_execution_capability_id) WHERE prepared_execution_capability_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_run_canonical_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.run_id,NEW.praxis_session_id,NEW.operation_id,NEW.prepared_execution_capability_id)
    IS DISTINCT FROM (OLD.run_id,OLD.praxis_session_id,OLD.operation_id,OLD.prepared_execution_capability_id) THEN
    RAISE EXCEPTION 'RUN_CANONICAL_BINDING_IMMUTABLE';
  END IF;
  IF NEW.prepared_execution_capability_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM prepared_execution_capabilities capability
    JOIN protected_operations operation ON operation.id=capability.protected_operation_id
    JOIN runs run ON run.id=NEW.run_id
    WHERE capability.id=NEW.prepared_execution_capability_id
      AND operation.operation_id=NEW.operation_id AND operation.praxis_session_id=NEW.praxis_session_id
      AND capability.project_id=run.project_id AND capability.environment_id=run.environment_id
      AND capability.mission_id=run.mission_id AND capability.objective_id=run.objective_id
      AND capability.agent_session_id=run.agent_session_id
  ) THEN RAISE EXCEPTION 'RUN_CANONICAL_BINDING_SCOPE_MISMATCH'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS run_canonical_binding ON run_operation_links;
CREATE TRIGGER run_canonical_binding BEFORE INSERT OR UPDATE ON run_operation_links
FOR EACH ROW EXECUTE FUNCTION enforce_run_canonical_binding();

CREATE TABLE IF NOT EXISTS typed_value_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid REFERENCES environments(id) ON DELETE RESTRICT,
  application_key text NOT NULL CHECK(application_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,99}$'),
  classification text NOT NULL CHECK(classification IN ('public','protected')),
  producer_protected_operation_id uuid NOT NULL REFERENCES protected_operations(id) ON DELETE RESTRICT,
  operation_contract_revision_id uuid NOT NULL REFERENCES operation_contract_revisions(id) ON DELETE RESTRICT,
  canonical_output_key text NOT NULL CHECK(canonical_output_key ~ '^[a-z][A-Za-z0-9]{0,99}$'),
  identity_role text CHECK(identity_role IS NULL OR identity_role IN ('resource_identity','continuation_identity')),
  transport_extractor jsonb,
  resource_effect jsonb,
  generated_public_value_id uuid REFERENCES generated_public_values(id) ON DELETE RESTRICT,
  project_credential_id uuid REFERENCES project_credentials(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked','expired','compromised')),
  privacy_seal text NOT NULL DEFAULT 'sealed' CHECK(privacy_seal='sealed'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(producer_protected_operation_id,canonical_output_key),
  CHECK((classification='public' AND generated_public_value_id IS NOT NULL AND project_credential_id IS NULL)
    OR (classification='protected' AND project_credential_id IS NOT NULL AND generated_public_value_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS typed_value_asset_single_identity
  ON typed_value_assets(producer_protected_operation_id) WHERE identity_role IS NOT NULL;

-- The attempt fuse keeps its original immutable owner anchor. Subsequent
-- owners are append-only associations, not a new attempt or mutation budget.
CREATE TABLE IF NOT EXISTS q5_attempt_praxis_sessions (
  attempt_id uuid NOT NULL REFERENCES q5_authoritative_attempts(id) ON DELETE RESTRICT,
  praxis_session_id uuid NOT NULL REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  epoch integer NOT NULL CHECK(epoch>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(attempt_id,praxis_session_id),
  UNIQUE(attempt_id,epoch)
);

CREATE OR REPLACE FUNCTION protect_q5_runtime_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Q5_RUNTIME_HISTORY_IMMUTABLE';
END $$;
DROP TRIGGER IF EXISTS q5_runtime_history_immutable ON q5_attempt_praxis_sessions;
CREATE TRIGGER q5_runtime_history_immutable BEFORE UPDATE OR DELETE ON q5_attempt_praxis_sessions
FOR EACH ROW EXECUTE FUNCTION protect_q5_runtime_history();

CREATE TABLE IF NOT EXISTS value_use_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  value_asset_id uuid NOT NULL REFERENCES typed_value_assets(id) ON DELETE RESTRICT,
  producer_protected_operation_id uuid NOT NULL REFERENCES protected_operations(id) ON DELETE RESTRICT,
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  consumer_protected_operation_id uuid NOT NULL REFERENCES protected_operations(id) ON DELETE RESTRICT,
  consumer_prepared_execution_capability_id uuid NOT NULL
    REFERENCES prepared_execution_capabilities(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  application_key text NOT NULL CHECK(application_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,99}$'),
  canonical_field_key text NOT NULL CHECK(canonical_field_key ~ '^[a-z][A-Za-z0-9]{0,99}$'),
  presentation_class text NOT NULL CHECK(presentation_class IN (
    'plain_text','protected_text','json_public','json_protected'
  )),
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL DEFAULT 1 CHECK(max_uses = 1),
  use_count integer NOT NULL DEFAULT 0 CHECK(use_count >= 0 AND use_count <= max_uses),
  state text NOT NULL DEFAULT 'active'
    CHECK(state IN ('active','consumed','revoked','expired','invalidated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  revoked_at timestamptz,
  UNIQUE(consumer_prepared_execution_capability_id,canonical_field_key)
);

ALTER TABLE operation_value_bindings
  ADD COLUMN IF NOT EXISTS value_use_grant_id uuid REFERENCES value_use_grants(id) ON DELETE RESTRICT;
ALTER TABLE operation_value_bindings
  DROP CONSTRAINT IF EXISTS operation_value_bindings_source_kind_check;
ALTER TABLE operation_value_bindings
  ADD CONSTRAINT operation_value_bindings_source_kind_check CHECK(source_kind IN (
    'literal_public','stored_public','protected_reference','generated_safe','generated_protected',
    'synthetic_protected'
  ));

-- New synthetic inputs bind canonical field keys; retain historical snake-case semantics.
ALTER TABLE operation_bound_protected_inputs
  DROP CONSTRAINT IF EXISTS operation_bound_protected_inputs_semantic_check;
ALTER TABLE operation_bound_protected_inputs
  ADD CONSTRAINT operation_bound_protected_inputs_semantic_check
    CHECK(semantic ~ '^[a-z][A-Za-z0-9_]{0,99}$');

ALTER TABLE mission_operation_checkpoints
  ADD COLUMN IF NOT EXISTS prepared_execution_capability_id uuid
    REFERENCES prepared_execution_capabilities(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS canonical_output_references jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_identity_value_asset_id uuid
    REFERENCES typed_value_assets(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS retrieved_identity_value_asset_id uuid
    REFERENCES typed_value_assets(id) ON DELETE RESTRICT;

ALTER TABLE q5_prepared_scopes
  ADD COLUMN IF NOT EXISTS client_id_value_asset_id uuid
    REFERENCES typed_value_assets(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS client_secret_value_asset_id uuid
    REFERENCES typed_value_assets(id) ON DELETE RESTRICT;

ALTER TABLE q5_prepared_scopes DROP CONSTRAINT IF EXISTS q5_prepared_scopes_q5_mcp_profile_check;
ALTER TABLE q5_prepared_scopes ADD CONSTRAINT q5_prepared_scopes_q5_mcp_profile_check CHECK (
  (q5_mcp_profile='q5-authoritative-v1' AND client_id_value_asset_id IS NULL AND client_secret_value_asset_id IS NULL)
  OR (q5_mcp_profile IN ('q5-canonical-v2','q5-thin-kernel-v3') AND client_id_value_asset_id IS NOT NULL AND client_secret_value_asset_id IS NOT NULL)
);

ALTER TABLE qualification_applications
  DROP CONSTRAINT IF EXISTS qualification_applications_credential_reference_ids_check;
ALTER TABLE qualification_applications
  ADD CONSTRAINT qualification_applications_credential_reference_ids_check CHECK (
    jsonb_typeof(credential_reference_ids)='array' AND (
      jsonb_array_length(credential_reference_ids) BETWEEN 1 AND 20
      OR COALESCE((jsonb_array_length(credential_reference_ids)=0
        AND typed_value_references->'clientId'->>'kind'='generated_safe'
        AND typed_value_references->'clientSecret'->>'kind'='generated_protected'
        AND typed_value_references->'clientId'->>'valueAssetId' IS NOT NULL
        AND typed_value_references->'clientSecret'->>'valueAssetId' IS NOT NULL),false)
    )
  );

CREATE OR REPLACE FUNCTION protect_q5_canonical_value_assets()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.client_id_value_asset_id IS DISTINCT FROM OLD.client_id_value_asset_id
     OR NEW.client_secret_value_asset_id IS DISTINCT FROM OLD.client_secret_value_asset_id THEN
    RAISE EXCEPTION 'Q5_PREPARED_SCOPE_VALUE_ASSETS_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS q5_prepared_scope_value_assets_immutable ON q5_prepared_scopes;
CREATE TRIGGER q5_prepared_scope_value_assets_immutable BEFORE UPDATE ON q5_prepared_scopes
  FOR EACH ROW EXECUTE FUNCTION protect_q5_canonical_value_assets();

CREATE OR REPLACE FUNCTION protect_operation_contract_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id
     OR NEW.application_key<>OLD.application_key OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.adapter_key<>OLD.adapter_key OR NEW.adapter_version<>OLD.adapter_version
     OR NEW.operation_key<>OLD.operation_key OR NEW.revision<>OLD.revision OR NEW.facts<>OLD.facts
     OR NEW.provenance<>OLD.provenance OR NEW.semantic_digest<>OLD.semantic_digest
     OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Operation contract revisions are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS operation_contract_revisions_immutable ON operation_contract_revisions;
CREATE TRIGGER operation_contract_revisions_immutable BEFORE UPDATE OR DELETE
  ON operation_contract_revisions FOR EACH ROW EXECUTE FUNCTION protect_operation_contract_revision();

CREATE OR REPLACE FUNCTION reject_immutable_row_change()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION '% rows are immutable',TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS operation_contract_observations_immutable ON operation_contract_observations;
CREATE TRIGGER operation_contract_observations_immutable BEFORE UPDATE OR DELETE
  ON operation_contract_observations FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();
CREATE OR REPLACE FUNCTION protect_typed_value_asset()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id
     OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
     OR NEW.application_key<>OLD.application_key OR NEW.classification<>OLD.classification
     OR NEW.producer_protected_operation_id<>OLD.producer_protected_operation_id
     OR NEW.operation_contract_revision_id<>OLD.operation_contract_revision_id
     OR NEW.canonical_output_key<>OLD.canonical_output_key
     OR NEW.transport_extractor IS DISTINCT FROM OLD.transport_extractor
     OR NEW.resource_effect IS DISTINCT FROM OLD.resource_effect
     OR NEW.identity_role IS DISTINCT FROM OLD.identity_role
     OR NEW.generated_public_value_id IS DISTINCT FROM OLD.generated_public_value_id
     OR NEW.project_credential_id IS DISTINCT FROM OLD.project_credential_id
     OR NEW.privacy_seal<>OLD.privacy_seal OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Typed value asset provenance is immutable';
  END IF;
  IF OLD.state<>'active' AND NEW.state<>OLD.state THEN
    RAISE EXCEPTION 'Terminal typed value asset state is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS typed_value_assets_immutable ON typed_value_assets;
CREATE TRIGGER typed_value_assets_immutable BEFORE UPDATE OR DELETE
  ON typed_value_assets FOR EACH ROW EXECUTE FUNCTION protect_typed_value_asset();

CREATE OR REPLACE FUNCTION protect_runtime_interaction_capability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.id<>OLD.id
     OR NEW.operation_contract_revision_id<>OLD.operation_contract_revision_id
     OR NEW.operation_contract_revision_digest<>OLD.operation_contract_revision_digest
     OR NEW.praxis_session_id<>OLD.praxis_session_id OR NEW.runtime_owner_id<>OLD.runtime_owner_id
     OR NEW.fencing_epoch<>OLD.fencing_epoch OR NEW.document_epoch<>OLD.document_epoch
     OR NEW.origin<>OLD.origin OR NEW.activation_control_reference<>OLD.activation_control_reference
     OR NEW.input_control_references<>OLD.input_control_references OR NEW.issued_at<>OLD.issued_at
     THEN
    RAISE EXCEPTION 'Runtime interaction capability authority is immutable';
  END IF;
  IF NEW.expires_at<>OLD.expires_at
     AND (OLD.state<>'active' OR NEW.expires_at<OLD.expires_at) THEN
    RAISE EXCEPTION 'Runtime interaction capability expiry may only be renewed';
  END IF;
  IF OLD.state<>'active' AND NEW.state<>OLD.state THEN
    RAISE EXCEPTION 'Terminal runtime interaction capability is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_interaction_capabilities_immutable ON runtime_interaction_capabilities;
CREATE TRIGGER runtime_interaction_capabilities_immutable BEFORE UPDATE OR DELETE
  ON runtime_interaction_capabilities FOR EACH ROW EXECUTE FUNCTION protect_runtime_interaction_capability();

CREATE OR REPLACE FUNCTION protect_execution_policy_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Execution policy snapshots are immutable';
END $$;
DROP TRIGGER IF EXISTS execution_policy_snapshots_immutable ON execution_policy_snapshots;
CREATE TRIGGER execution_policy_snapshots_immutable BEFORE UPDATE OR DELETE
  ON execution_policy_snapshots FOR EACH ROW EXECUTE FUNCTION protect_execution_policy_snapshot();

CREATE OR REPLACE FUNCTION protect_prepared_execution_capability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.protected_operation_id<>OLD.protected_operation_id
     OR NEW.mutation_identity<>OLD.mutation_identity
     OR NEW.operation_contract_revision_id<>OLD.operation_contract_revision_id
     OR NEW.operation_contract_revision_digest<>OLD.operation_contract_revision_digest
     OR NEW.runtime_interaction_capability_id<>OLD.runtime_interaction_capability_id
     OR NEW.execution_policy_snapshot_id<>OLD.execution_policy_snapshot_id
     OR NEW.execution_policy_snapshot_digest<>OLD.execution_policy_snapshot_digest
     OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id
     OR NEW.mission_id<>OLD.mission_id OR NEW.objective_id<>OLD.objective_id
     OR NEW.agent_session_id<>OLD.agent_session_id OR NEW.application_key<>OLD.application_key
     OR NEW.dispatch_semantics<>OLD.dispatch_semantics OR NEW.effect_semantics<>OLD.effect_semantics
     OR NEW.target_commitment<>OLD.target_commitment OR NEW.input_commitment<>OLD.input_commitment
     OR NEW.output_commitment<>OLD.output_commitment OR NEW.resource_effect IS DISTINCT FROM OLD.resource_effect
     OR NEW.expires_at<>OLD.expires_at OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Prepared execution capability authority is immutable';
  END IF;
  IF OLD.state<>'reserved' AND (NEW.program_manifest IS DISTINCT FROM OLD.program_manifest
      OR NEW.program_digest IS DISTINCT FROM OLD.program_digest OR NEW.state<>OLD.state
      OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at) THEN
    RAISE EXCEPTION 'Finalized prepared execution capability is immutable';
  END IF;
  IF OLD.state='reserved' AND NEW.state='finalized'
     AND (NEW.program_manifest IS NULL OR NEW.program_digest IS NULL OR NEW.finalized_at IS NULL) THEN
    RAISE EXCEPTION 'Prepared execution capability finalization is incomplete';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS prepared_execution_capabilities_immutable ON prepared_execution_capabilities;
CREATE TRIGGER prepared_execution_capabilities_immutable BEFORE UPDATE OR DELETE
  ON prepared_execution_capabilities FOR EACH ROW EXECUTE FUNCTION protect_prepared_execution_capability();

CREATE OR REPLACE FUNCTION protect_value_use_grant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Forward installs retain historical grant rows unchanged. New grants are
  -- one-use, and old multi-use grants cannot become new execution authority.
  IF TG_OP='INSERT' THEN
    IF NEW.max_uses<>1 OR NEW.use_count<>0 OR NEW.state<>'active' THEN
      RAISE EXCEPTION 'VALUE_USE_GRANT_MUST_BE_FRESH_ONE_USE';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.value_asset_id<>OLD.value_asset_id
     OR NEW.producer_protected_operation_id<>OLD.producer_protected_operation_id
     OR NEW.mission_id<>OLD.mission_id OR NEW.consumer_protected_operation_id<>OLD.consumer_protected_operation_id
     OR NEW.consumer_prepared_execution_capability_id<>OLD.consumer_prepared_execution_capability_id
     OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id
     OR NEW.application_key<>OLD.application_key OR NEW.canonical_field_key<>OLD.canonical_field_key
     OR NEW.presentation_class<>OLD.presentation_class OR NEW.expires_at<>OLD.expires_at
     OR NEW.max_uses<>OLD.max_uses OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Value use grant authority is immutable';
  END IF;
  IF OLD.state<>'active' AND (NEW.state<>OLD.state OR NEW.use_count<>OLD.use_count) THEN
    RAISE EXCEPTION 'Terminal value use grant is immutable';
  END IF;
  IF NEW.use_count<>OLD.use_count AND
     (OLD.max_uses<>1 OR OLD.use_count<>0 OR NEW.use_count<>1 OR NEW.state<>'consumed') THEN
    RAISE EXCEPTION 'VALUE_USE_GRANT_INVALID_CONSUMPTION';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS value_use_grants_immutable ON value_use_grants;
CREATE TRIGGER value_use_grants_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON value_use_grants FOR EACH ROW EXECUTE FUNCTION protect_value_use_grant();

-- Generated backing storage is provenance, never an independently editable
-- credential or an Environment membership authorization.
CREATE OR REPLACE FUNCTION protect_generated_credential_backing()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.origin_protected_operation_id IS NOT NULL AND (
       NEW.origin_protected_operation_id IS DISTINCT FROM OLD.origin_protected_operation_id
       OR NEW.project_id<>OLD.project_id OR NEW.name<>OLD.name
       OR NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
       OR NEW.initialization_vector IS DISTINCT FROM OLD.initialization_vector
       OR NEW.authentication_tag IS DISTINCT FROM OLD.authentication_tag) THEN
    RAISE EXCEPTION 'GENERATED_VALUE_BACKING_IMMUTABLE';
  END IF;
  IF NEW.deleted_at IS NOT NULL OR NEW.security_status<>'active' THEN
    UPDATE typed_value_assets SET state=CASE WHEN NEW.security_status='compromised' THEN 'compromised' ELSE 'revoked' END
      WHERE project_credential_id=NEW.id AND state='active';
    UPDATE value_use_grants SET state='revoked',revoked_at=now()
      WHERE state='active' AND value_asset_id IN (
        SELECT id FROM typed_value_assets WHERE project_credential_id=NEW.id);

  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS generated_credential_backing_guard ON project_credentials;
CREATE TRIGGER generated_credential_backing_guard BEFORE UPDATE ON project_credentials
  FOR EACH ROW EXECUTE FUNCTION protect_generated_credential_backing();

CREATE OR REPLACE FUNCTION require_manual_environment_credentials()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM project_credentials credential
    WHERE credential.origin_protected_operation_id IS NOT NULL
      AND NEW.secret_refs ? credential.id::text) THEN
    RAISE EXCEPTION 'GENERATED_VALUES_REQUIRE_EXPLICIT_USE_GRANTS';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS environment_manual_credentials_only ON environments;
CREATE TRIGGER environment_manual_credentials_only BEFORE INSERT OR UPDATE OF secret_refs ON environments
  FOR EACH ROW EXECUTE FUNCTION require_manual_environment_credentials();

CREATE OR REPLACE FUNCTION protect_generated_public_backing()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_protected_operation_id IS NOT NULL AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'GENERATED_PUBLIC_VALUE_BACKING_IMMUTABLE';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS generated_public_backing_guard ON generated_public_values;
CREATE TRIGGER generated_public_backing_guard BEFORE UPDATE OR DELETE ON generated_public_values
  FOR EACH ROW EXECUTE FUNCTION protect_generated_public_backing();

-- Replace the legacy JSONPath-to-key Chronicle trigger with canonical output provenance.
CREATE OR REPLACE FUNCTION chronicle_protected_mutation_checkpoint()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE continuations text[];
DECLARE receipt text;
DECLARE declared_continuation text;
DECLARE identity_asset uuid;
DECLARE created_digest text;
DECLARE canonical_refs jsonb;
DECLARE capability_id uuid;
BEGIN
  IF NEW.authority_model<>'canonical' OR NEW.owner_kind<>'authoring_session'
     OR NEW.dispatch_semantics<>'mutation' OR NEW.mutation_outcome NOT IN ('applied','unknown') THEN
    RETURN NEW;
  END IF;
  IF NEW.mutation_outcome='applied' AND NEW.state NOT IN ('persisted','completed') THEN RETURN NEW; END IF;
  IF NEW.mutation_outcome='unknown' AND NEW.state<>'recovery_required' THEN RETURN NEW; END IF;

  SELECT revision.facts->'response'->>'continuation',capability.id
    INTO declared_continuation,capability_id
    FROM prepared_execution_capabilities capability
    JOIN operation_contract_revisions revision ON revision.id=capability.operation_contract_revision_id
   WHERE capability.protected_operation_id=NEW.id;
  SELECT COALESCE(jsonb_object_agg(output.canonical_output_key,jsonb_build_object(
           'valueAssetId',output.id,'classification',output.classification,
           'identityRole',output.identity_role)), '{}'::jsonb)
    INTO canonical_refs FROM typed_value_assets output
   WHERE output.producer_protected_operation_id=NEW.id;
  SELECT output.id INTO identity_asset
    FROM typed_value_assets output
   WHERE output.producer_protected_operation_id=NEW.id
     AND output.identity_role IN ('resource_identity','continuation_identity');
  IF identity_asset IS NOT NULL THEN
    SELECT encode(digest(value.value,'sha256'),'hex') INTO created_digest
      FROM typed_value_assets asset
      JOIN generated_public_values value ON value.id=asset.generated_public_value_id
     WHERE asset.id=identity_asset AND asset.classification='public';
  END IF;
  continuations := CASE
    WHEN NEW.mutation_outcome='unknown' THEN ARRAY['reconcile']::text[]
    WHEN declared_continuation='read_only_retrieve'
      THEN ARRAY['read_only_retrieve','reconcile']::text[]
    ELSE ARRAY['reconcile']::text[] END;
  receipt := encode(digest(concat_ws('|',NEW.id::text,NEW.mutation_identity,NEW.mutation_outcome,
    NEW.dispatch_state,canonical_refs::text,NEW.version::text),'sha256'),'hex');
  INSERT INTO mission_operation_checkpoints(
    mission_id,objective_id,environment_id,source_protected_operation_id,
    mutation_receipt_digest,mutation_outcome,dispatch_acknowledged,persisted_references,
    permitted_continuations,created_identity_digest,prepared_execution_capability_id,
    canonical_output_references,created_identity_value_asset_id
  ) VALUES(NEW.mission_id,NEW.objective_id,NEW.environment_id,NEW.id,receipt,
    NEW.mutation_outcome,NEW.dispatch_state='acknowledged',NEW.persisted_references,continuations,
    created_digest,capability_id,canonical_refs,identity_asset)
  ON CONFLICT(source_protected_operation_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION settle_mission_operation_checkpoint_consumer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_asset uuid;
DECLARE retrieved_digest text;
BEGIN
  IF NEW.authority_model<>'canonical' THEN RETURN NEW; END IF;
  IF NEW.state IN ('persisted','completed') THEN
    SELECT output.id INTO identity_asset
      FROM typed_value_assets output
     WHERE output.producer_protected_operation_id=NEW.id
       AND output.identity_role IN ('resource_identity','continuation_identity');
    IF identity_asset IS NOT NULL THEN
      SELECT encode(digest(value.value,'sha256'),'hex') INTO retrieved_digest
        FROM typed_value_assets asset
        JOIN generated_public_values value ON value.id=asset.generated_public_value_id
       WHERE asset.id=identity_asset AND asset.classification='public';
    END IF;
    UPDATE mission_operation_checkpoints SET state='completed',completed_at=now(),
      retrieved_identity_value_asset_id=identity_asset,retrieved_identity_digest=retrieved_digest,
      identity_matches=created_identity_value_asset_id IS NOT NULL AND identity_asset IS NOT NULL
        AND created_identity_digest IS NOT NULL AND retrieved_digest IS NOT NULL
        AND created_identity_digest=retrieved_digest
    WHERE claimed_by_protected_operation_id=NEW.id AND state='claimed';
  ELSIF NEW.state IN ('recovery_required','failed_not_applied','compromised','revoked','abandoned') THEN
    UPDATE mission_operation_checkpoints SET state='blocked'
    WHERE claimed_by_protected_operation_id=NEW.id AND state='claimed';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON TABLE operation_contract_revisions IS
  'Provider-neutral immutable observed operation facts; contains no executable browser references.';
COMMENT ON TABLE runtime_interaction_capabilities IS
  'Short-lived exact browser interaction authority bound to owner, fence, and document epoch.';
COMMENT ON TABLE prepared_execution_capabilities IS
  'Sole immutable operation-lifetime execution authority for new protected dispatch.';
COMMENT ON TABLE value_use_grants IS
  'Internal one-use resolution binding; exact scope and presentation are checked at reservation.';

-- Numeric effect accounting is scoped to the durable Mission, never the browser
-- owner or caller-chosen operation UUID. Historical dispatches are counted once.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='missions' AND column_name='business_mutation_dispatches_consumed') THEN
    ALTER TABLE missions ADD COLUMN max_business_mutation_dispatches integer NOT NULL DEFAULT 1
      CHECK(max_business_mutation_dispatches BETWEEN 0 AND 1000);
    ALTER TABLE missions ADD COLUMN business_mutation_dispatches_consumed integer NOT NULL DEFAULT 0
      CHECK(business_mutation_dispatches_consumed>=0);
    UPDATE missions mission SET business_mutation_dispatches_consumed=(
      SELECT count(*) FROM protected_operations operation
      LEFT JOIN prepared_execution_capabilities capability ON capability.id=operation.prepared_execution_capability_id
      WHERE operation.mission_id=mission.id AND operation.dispatch_semantics='mutation'
        AND operation.dispatch_state IN ('started','acknowledged')
        AND (capability.id IS NULL OR 'business_effect'=ANY(capability.effect_semantics))
    );
  END IF;
END $$;
CREATE OR REPLACE FUNCTION protect_mission_effect_budget()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.max_business_mutation_dispatches<>OLD.max_business_mutation_dispatches
     OR NEW.business_mutation_dispatches_consumed<OLD.business_mutation_dispatches_consumed
     OR NEW.business_mutation_dispatches_consumed>OLD.business_mutation_dispatches_consumed+1 THEN
    RAISE EXCEPTION 'MISSION_EFFECT_BUDGET_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mission_effect_budget_immutable ON missions;
CREATE TRIGGER mission_effect_budget_immutable BEFORE UPDATE ON missions
  FOR EACH ROW EXECUTE FUNCTION protect_mission_effect_budget();

-- The cutoff is enforced beneath workers as well as at API/kernel admission. Existing
-- uncertain rows remain available for reconciliation; no legacy row may newly dispatch.
CREATE OR REPLACE FUNCTION enforce_canonical_protected_dispatch_cutoff()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('ready_to_dispatch','dispatching') AND NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.authority_model<>'canonical' OR NEW.prepared_execution_capability_id IS NULL THEN
      RAISE EXCEPTION 'LEGACY_PROTECTED_OPERATION_DISPATCH_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM prepared_execution_capabilities capability
      JOIN missions mission ON mission.id=capability.mission_id AND mission.status NOT IN ('cancelled','completed','failed')
      JOIN agent_sessions agent ON agent.id=capability.agent_session_id AND agent.mission_id=mission.id AND agent.status='active'
      JOIN operation_contract_revisions revision ON revision.id=capability.operation_contract_revision_id
       AND revision.retention_state='active' AND revision.staleness='current'
      JOIN runtime_interaction_capabilities interaction
        ON interaction.id=capability.runtime_interaction_capability_id
       AND interaction.state='active' AND interaction.expires_at>now()
      JOIN adaptive_session_runtime_leases lease ON lease.session_id=interaction.praxis_session_id
       AND lease.owner_id=interaction.runtime_owner_id AND lease.fencing_token=interaction.fencing_epoch
       AND lease.lease_expires_at>now()
      WHERE capability.id=NEW.prepared_execution_capability_id
        AND capability.protected_operation_id=NEW.id AND capability.state='finalized'
        AND capability.expires_at>now() AND capability.program_digest=NEW.program_digest
        AND capability.mutation_identity::text=NEW.mutation_identity
        AND NOT EXISTS (
          SELECT 1 FROM operation_value_bindings binding
           WHERE binding.consumer_protected_operation_id=NEW.id
             AND binding.source_kind IN ('generated_safe','generated_protected')
             AND NOT EXISTS (
               SELECT 1 FROM value_use_grants grant_authority
               JOIN typed_value_assets asset ON asset.id=grant_authority.value_asset_id
                 AND asset.state='active'
               WHERE grant_authority.id=binding.value_use_grant_id
                 AND grant_authority.consumer_prepared_execution_capability_id=capability.id
                 AND grant_authority.consumer_protected_operation_id=NEW.id
                 AND grant_authority.canonical_field_key=binding.canonical_field_key
                 AND grant_authority.presentation_class=binding.presentation_class
                 AND grant_authority.max_uses=1 AND grant_authority.state='consumed' AND grant_authority.use_count=1
                 AND grant_authority.revoked_at IS NULL AND grant_authority.expires_at>now()
             )
        )
    ) THEN
      RAISE EXCEPTION 'CANONICAL_PROTECTED_DISPATCH_AUTHORITY_INVALID';
    END IF;
    IF NEW.state='dispatching' AND NEW.dispatch_semantics='mutation'
       AND EXISTS(SELECT 1 FROM prepared_execution_capabilities capability
         WHERE capability.id=NEW.prepared_execution_capability_id
           AND 'business_effect'=ANY(capability.effect_semantics)) THEN
      UPDATE missions SET business_mutation_dispatches_consumed=business_mutation_dispatches_consumed+1
        WHERE id=NEW.mission_id AND status NOT IN ('cancelled','failed','completed')
          AND business_mutation_dispatches_consumed<max_business_mutation_dispatches;
      IF NOT FOUND THEN RAISE EXCEPTION 'MISSION_BUSINESS_MUTATION_BUDGET_EXHAUSTED'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS canonical_protected_dispatch_cutoff ON protected_operations;
CREATE TRIGGER canonical_protected_dispatch_cutoff BEFORE UPDATE ON protected_operations
  FOR EACH ROW EXECUTE FUNCTION enforce_canonical_protected_dispatch_cutoff();

-- Durable completion is independent of current owner/grant expiry. Successful
-- read-only execution proves not_applied, never a fabricated applied mutation.
CREATE OR REPLACE VIEW canonical_completed_executions AS
SELECT operation.* FROM protected_operations operation
JOIN prepared_execution_capabilities capability
  ON capability.id=operation.prepared_execution_capability_id
 AND capability.protected_operation_id=operation.id
WHERE operation.authority_model='canonical' AND operation.state='completed'
  AND operation.dispatch_state='acknowledged' AND operation.acquisition_state='complete'
  AND operation.persistence_state='committed' AND operation.failure_code IS NULL
  AND ((operation.dispatch_semantics='mutation' AND operation.mutation_outcome='applied')
    OR (operation.dispatch_semantics='read_only' AND operation.mutation_outcome='not_applied'));
