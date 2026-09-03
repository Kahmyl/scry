-- Additive production cutover for prepared protected operations. Legacy rows remain
-- historical; only newly reserved operations carry immutable contract provenance.

ALTER TABLE protected_operations
  ADD COLUMN IF NOT EXISTS praxis_session_id uuid REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS runtime_owner_id uuid,
  ADD COLUMN IF NOT EXISTS runtime_fencing_epoch integer CHECK(runtime_fencing_epoch IS NULL OR runtime_fencing_epoch > 0),
  ADD COLUMN IF NOT EXISTS document_epoch integer CHECK(document_epoch IS NULL OR document_epoch >= 0),
  ADD COLUMN IF NOT EXISTS observed_operation_contract_id uuid,
  ADD COLUMN IF NOT EXISTS observed_operation_contract_digest text
    CHECK(observed_operation_contract_digest IS NULL OR observed_operation_contract_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS target_commitment text
    CHECK(target_commitment IS NULL OR target_commitment ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS input_commitment text
    CHECK(input_commitment IS NULL OR input_commitment ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS output_commitment text
    CHECK(output_commitment IS NULL OR output_commitment ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz;

ALTER TABLE protected_operations
  DROP CONSTRAINT IF EXISTS protected_operations_program_digest_check;
ALTER TABLE protected_operations
  ADD CONSTRAINT protected_operations_program_digest_check CHECK(
    (state='reserved' AND program_digest IS NULL)
    OR (praxis_session_id IS NOT NULL AND state='planned' AND program_digest IS NULL)
    OR (state NOT IN ('reserved') AND program_digest ~ '^[a-f0-9]{64}$')
  );

DO $$
DECLARE owner_constraint record;
BEGIN
  FOR owner_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='protected_operations'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%owner_kind%authorization_id%'
  LOOP
    EXECUTE format('ALTER TABLE protected_operations DROP CONSTRAINT %I', owner_constraint.conname);
  END LOOP;
END $$;
ALTER TABLE protected_operations
  ADD CONSTRAINT protected_operations_owner_shape_check CHECK(
    (owner_kind='authoring_session' AND authoring_session_id IS NOT NULL AND run_id IS NULL
      AND flow_draft_id IS NOT NULL AND (state='reserved' OR authorization_id IS NOT NULL))
    OR (owner_kind='run' AND run_id IS NOT NULL AND authoring_session_id IS NULL
      AND flow_revision_id IS NOT NULL)
  );

ALTER TABLE mission_authorizations
  ADD COLUMN IF NOT EXISTS protected_operation_id uuid REFERENCES protected_operations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS protected_operation_contract_digest text
    CHECK(protected_operation_contract_digest IS NULL OR protected_operation_contract_digest ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS mission_authorizations_prepared_operation_unique
  ON mission_authorizations(protected_operation_id)
  WHERE protected_operation_id IS NOT NULL AND status='approved';

CREATE TABLE IF NOT EXISTS observed_operation_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  praxis_session_id uuid NOT NULL REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  document_epoch integer NOT NULL CHECK(document_epoch >= 0),
  origin text NOT NULL CHECK(origin ~ '^https?://'),
  source_kind text NOT NULL CHECK(source_kind IN ('public_document','public_resource','runtime_observation')),
  observation_id text NOT NULL CHECK(length(observation_id) BETWEEN 1 AND 200),
  operation_key text NOT NULL CHECK(operation_key ~ '^[a-z][A-Za-z0-9]{0,99}$'),
  facts jsonb NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(praxis_session_id,document_epoch,digest),
  UNIQUE(id,digest),
  CHECK(facts::text !~* '(plaintext|ciphertext|secret.?value|credential.?value)')
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='protected_operations_observed_contract_fk') THEN
    ALTER TABLE protected_operations
      ADD CONSTRAINT protected_operations_observed_contract_fk
      FOREIGN KEY(observed_operation_contract_id,observed_operation_contract_digest)
      REFERENCES observed_operation_contracts(id,digest) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS operation_value_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_protected_operation_id uuid REFERENCES protected_operations(id) ON DELETE RESTRICT,
  consumer_praxis_session_id uuid REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  consumer_operation_id text,
  source_kind text NOT NULL CHECK(source_kind IN (
    'literal_public','stored_public','protected_reference','generated_safe','synthetic_protected'
  )),
  source_reference_id uuid,
  producer_protected_operation_id uuid REFERENCES protected_operations(id) ON DELETE RESTRICT,
  canonical_field_key text NOT NULL CHECK(canonical_field_key ~ '^[a-z][A-Za-z0-9]{0,99}$'),
  target_reference text NOT NULL CHECK(length(target_reference) BETWEEN 1 AND 200),
  presentation_class text NOT NULL CHECK(presentation_class IN (
    'plain_text','protected_text','json_public','json_protected'
  )),
  public_value text,
  source_commitment text NOT NULL CHECK(source_commitment ~ '^[a-f0-9]{64}$'),
  owner_fencing_epoch integer NOT NULL CHECK(owner_fencing_epoch > 0),
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL DEFAULT 1 CHECK(max_uses > 0 AND max_uses <= 100),
  use_count integer NOT NULL DEFAULT 0 CHECK(use_count >= 0),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','consumed','revoked','expired','invalidated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK(
    (consumer_protected_operation_id IS NOT NULL AND consumer_praxis_session_id IS NULL AND consumer_operation_id IS NULL)
    OR (consumer_protected_operation_id IS NULL AND consumer_praxis_session_id IS NOT NULL AND consumer_operation_id IS NOT NULL)
  ),
  CHECK(
    (source_kind='literal_public' AND public_value IS NOT NULL AND source_reference_id IS NULL)
    OR (source_kind<>'literal_public' AND public_value IS NULL AND source_reference_id IS NOT NULL)
  ),
  CHECK(source_kind<>'generated_safe' OR producer_protected_operation_id IS NOT NULL),
  CHECK(public_value IS NULL OR length(public_value) <= 20000)
);

CREATE INDEX IF NOT EXISTS operation_value_bindings_consumer_state_idx
  ON operation_value_bindings(consumer_protected_operation_id,state,expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS operation_value_bindings_protected_consumer_field_unique
  ON operation_value_bindings(consumer_protected_operation_id,canonical_field_key)
  WHERE consumer_protected_operation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS operation_value_bindings_praxis_consumer_field_unique
  ON operation_value_bindings(consumer_praxis_session_id,consumer_operation_id,canonical_field_key)
  WHERE consumer_praxis_session_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operation_value_bindings_adaptive_consumer_fk') THEN
    ALTER TABLE operation_value_bindings
      ADD CONSTRAINT operation_value_bindings_adaptive_consumer_fk
      FOREIGN KEY(consumer_praxis_session_id,consumer_operation_id)
      REFERENCES adaptive_operations(session_id,operation_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS mission_operation_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  objective_id uuid NOT NULL,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  source_protected_operation_id uuid NOT NULL UNIQUE REFERENCES protected_operations(id) ON DELETE RESTRICT,
  mutation_receipt_digest text NOT NULL CHECK(mutation_receipt_digest ~ '^[a-f0-9]{64}$'),
  mutation_outcome text NOT NULL CHECK(mutation_outcome IN ('applied','unknown')),
  dispatch_acknowledged boolean NOT NULL,
  persisted_references jsonb NOT NULL DEFAULT '{}'::jsonb,
  permitted_continuations text[] NOT NULL,
  source_mutation_repeatable boolean NOT NULL DEFAULT false CHECK(source_mutation_repeatable=false),
  state text NOT NULL DEFAULT 'available' CHECK(state IN ('available','claimed','completed','blocked')),
  claimed_by_protected_operation_id uuid REFERENCES protected_operations(id) ON DELETE RESTRICT,
  created_identity_digest text CHECK(created_identity_digest IS NULL OR created_identity_digest ~ '^[a-f0-9]{64}$'),
  retrieved_identity_digest text CHECK(retrieved_identity_digest IS NULL OR retrieved_identity_digest ~ '^[a-f0-9]{64}$'),
  identity_matches boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY(objective_id,mission_id) REFERENCES mission_objectives(id,mission_id) ON DELETE RESTRICT,
  CHECK(permitted_continuations <@ ARRAY['read_only_retrieve','reconcile']::text[]),
  CHECK(cardinality(permitted_continuations) BETWEEN 1 AND 2),
  CHECK(mutation_outcome<>'unknown' OR permitted_continuations=ARRAY['reconcile']::text[]),
  CHECK(persisted_references::text !~* '(plaintext|ciphertext|password|secret.?value|credential.?value|bearer)')
);

CREATE OR REPLACE FUNCTION protect_observed_operation_contract_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Observed operation contracts are append-only';
END $$;
DROP TRIGGER IF EXISTS observed_operation_contracts_append_only ON observed_operation_contracts;
CREATE TRIGGER observed_operation_contracts_append_only
  BEFORE UPDATE OR DELETE ON observed_operation_contracts
  FOR EACH ROW EXECUTE FUNCTION protect_observed_operation_contract_history();

CREATE OR REPLACE FUNCTION protect_prepared_operation_commitments()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.operation_id<>NEW.operation_id
     OR OLD.praxis_session_id IS DISTINCT FROM NEW.praxis_session_id
     OR OLD.runtime_owner_id IS DISTINCT FROM NEW.runtime_owner_id
     OR OLD.runtime_fencing_epoch IS DISTINCT FROM NEW.runtime_fencing_epoch
     OR OLD.document_epoch IS DISTINCT FROM NEW.document_epoch
     OR OLD.observed_operation_contract_id IS DISTINCT FROM NEW.observed_operation_contract_id
     OR OLD.observed_operation_contract_digest IS DISTINCT FROM NEW.observed_operation_contract_digest
     OR OLD.target_commitment IS DISTINCT FROM NEW.target_commitment
     OR OLD.input_commitment IS DISTINCT FROM NEW.input_commitment
     OR OLD.output_commitment IS DISTINCT FROM NEW.output_commitment THEN
    RAISE EXCEPTION 'Prepared protected operation commitments are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protected_operations_prepared_commitments_immutable ON protected_operations;
CREATE TRIGGER protected_operations_prepared_commitments_immutable
  BEFORE UPDATE ON protected_operations
  FOR EACH ROW WHEN (OLD.praxis_session_id IS NOT NULL)
  EXECUTE FUNCTION protect_prepared_operation_commitments();

CREATE OR REPLACE FUNCTION protect_operation_value_binding_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumer_protected_operation_id IS DISTINCT FROM NEW.consumer_protected_operation_id
     OR OLD.consumer_praxis_session_id IS DISTINCT FROM NEW.consumer_praxis_session_id
     OR OLD.consumer_operation_id IS DISTINCT FROM NEW.consumer_operation_id
     OR OLD.source_kind<>NEW.source_kind
     OR OLD.source_reference_id IS DISTINCT FROM NEW.source_reference_id
     OR OLD.producer_protected_operation_id IS DISTINCT FROM NEW.producer_protected_operation_id
     OR OLD.canonical_field_key<>NEW.canonical_field_key
     OR OLD.target_reference<>NEW.target_reference
     OR OLD.presentation_class<>NEW.presentation_class
     OR OLD.public_value IS DISTINCT FROM NEW.public_value
     OR OLD.source_commitment<>NEW.source_commitment
     OR OLD.owner_fencing_epoch<>NEW.owner_fencing_epoch
     OR OLD.expires_at<>NEW.expires_at OR OLD.max_uses<>NEW.max_uses THEN
    RAISE EXCEPTION 'Operation value binding identity is immutable';
  END IF;
  IF OLD.state<>'active' AND NEW.state<>OLD.state THEN
    RAISE EXCEPTION 'Terminal operation value binding is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS operation_value_bindings_identity_immutable ON operation_value_bindings;
CREATE TRIGGER operation_value_bindings_identity_immutable
  BEFORE UPDATE ON operation_value_bindings
  FOR EACH ROW EXECUTE FUNCTION protect_operation_value_binding_identity();

CREATE OR REPLACE FUNCTION protect_mission_operation_checkpoint_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.mission_id<>NEW.mission_id OR OLD.objective_id<>NEW.objective_id
     OR OLD.environment_id<>NEW.environment_id
     OR OLD.source_protected_operation_id<>NEW.source_protected_operation_id
     OR OLD.mutation_receipt_digest<>NEW.mutation_receipt_digest
     OR OLD.mutation_outcome<>NEW.mutation_outcome
     OR OLD.dispatch_acknowledged<>NEW.dispatch_acknowledged
     OR OLD.persisted_references<>NEW.persisted_references
     OR OLD.permitted_continuations<>NEW.permitted_continuations
     OR OLD.source_mutation_repeatable<>NEW.source_mutation_repeatable THEN
    RAISE EXCEPTION 'Mission operation checkpoint evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mission_operation_checkpoints_evidence_immutable ON mission_operation_checkpoints;
CREATE TRIGGER mission_operation_checkpoints_evidence_immutable
  BEFORE UPDATE ON mission_operation_checkpoints
  FOR EACH ROW EXECUTE FUNCTION protect_mission_operation_checkpoint_identity();

COMMENT ON TABLE mission_operation_checkpoints IS
  'Chronicle-owned business mutation receipts; intentionally separate from browser successor checkpoints.';

CREATE OR REPLACE FUNCTION chronicle_protected_mutation_checkpoint()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE continuations text[];
DECLARE receipt text;
DECLARE declared_continuation text;
DECLARE identity_key text;
DECLARE created_digest text;
BEGIN
  IF NEW.owner_kind<>'authoring_session' OR NEW.dispatch_semantics<>'mutation'
     OR NEW.mutation_outcome NOT IN ('applied','unknown') THEN
    RETURN NEW;
  END IF;
  IF NEW.mutation_outcome='applied' AND NEW.state NOT IN ('persisted','completed') THEN RETURN NEW; END IF;
  IF NEW.mutation_outcome='unknown' AND NEW.state<>'recovery_required' THEN RETURN NEW; END IF;
  SELECT facts->'response'->>'continuation' INTO declared_continuation
    FROM observed_operation_contracts WHERE id=NEW.observed_operation_contract_id;
  SELECT regexp_replace(facts->'response'->>'publicIdentityOutputPath','^\$\.','')
    INTO identity_key FROM observed_operation_contracts
    WHERE id=NEW.observed_operation_contract_id;
  IF identity_key ~ '^[a-z][A-Za-z0-9]{0,99}$' THEN
    SELECT encode(digest(value,'sha256'),'hex') INTO created_digest
      FROM generated_public_values
      WHERE id=(NEW.persisted_references->identity_key->>'valueId')::uuid
        AND source_protected_operation_id=NEW.id;
  END IF;
  continuations := CASE
    WHEN NEW.mutation_outcome='unknown' THEN ARRAY['reconcile']::text[]
    WHEN declared_continuation='read_only_retrieve'
      THEN ARRAY['read_only_retrieve','reconcile']::text[]
    ELSE ARRAY['reconcile']::text[] END;
  receipt := encode(digest(concat_ws('|',NEW.id::text,NEW.operation_id,NEW.mutation_outcome,
    NEW.dispatch_state,NEW.persisted_references::text,NEW.version::text),'sha256'),'hex');
  INSERT INTO mission_operation_checkpoints(
    mission_id,objective_id,environment_id,source_protected_operation_id,
    mutation_receipt_digest,mutation_outcome,dispatch_acknowledged,persisted_references,
    permitted_continuations,created_identity_digest
  ) VALUES(NEW.mission_id,NEW.objective_id,NEW.environment_id,NEW.id,receipt,
    NEW.mutation_outcome,NEW.dispatch_state='acknowledged',NEW.persisted_references,continuations,
    created_digest)
  ON CONFLICT(source_protected_operation_id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protected_operations_chronicle_checkpoint ON protected_operations;
CREATE TRIGGER protected_operations_chronicle_checkpoint
  AFTER UPDATE ON protected_operations
  FOR EACH ROW EXECUTE FUNCTION chronicle_protected_mutation_checkpoint();

CREATE OR REPLACE FUNCTION settle_mission_operation_checkpoint_consumer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_key text;
DECLARE retrieved_digest text;
BEGIN
  IF NEW.state IN ('persisted','completed') THEN
    SELECT regexp_replace(contract.facts->'response'->>'publicIdentityOutputPath','^\$\.','')
      INTO identity_key
      FROM observed_operation_contracts contract
      WHERE contract.id=NEW.observed_operation_contract_id;
    IF identity_key ~ '^[a-z][A-Za-z0-9]{0,99}$' THEN
      SELECT encode(digest(value,'sha256'),'hex') INTO retrieved_digest
        FROM generated_public_values
        WHERE id=(NEW.persisted_references->identity_key->>'valueId')::uuid
          AND source_protected_operation_id=NEW.id;
    END IF;
    UPDATE mission_operation_checkpoints SET state='completed',completed_at=now(),
      retrieved_identity_digest=retrieved_digest,
      identity_matches=created_identity_digest IS NOT NULL
        AND retrieved_digest IS NOT NULL AND created_identity_digest=retrieved_digest
    WHERE claimed_by_protected_operation_id=NEW.id AND state='claimed';
  ELSIF NEW.state IN ('recovery_required','failed_not_applied','compromised','revoked','abandoned') THEN
    UPDATE mission_operation_checkpoints SET state='blocked'
    WHERE claimed_by_protected_operation_id=NEW.id AND state='claimed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protected_operations_checkpoint_consumer_settlement ON protected_operations;
CREATE TRIGGER protected_operations_checkpoint_consumer_settlement
  AFTER UPDATE ON protected_operations
  FOR EACH ROW EXECUTE FUNCTION settle_mission_operation_checkpoint_consumer();
