ALTER TABLE protected_operations ALTER COLUMN program_digest DROP NOT NULL;
ALTER TABLE protected_operations DROP CONSTRAINT IF EXISTS protected_operations_program_digest_check;
ALTER TABLE protected_operations ADD CONSTRAINT protected_operations_program_digest_check CHECK(
  (state='reserved' AND program_digest IS NULL)
  OR (state<>'reserved' AND program_digest ~ '^[a-f0-9]{64}$')
);
ALTER TABLE protected_operations DROP CONSTRAINT IF EXISTS protected_operations_state_check;
ALTER TABLE protected_operations ADD CONSTRAINT protected_operations_state_check CHECK(state IN (
  'reserved','planned','preparing','ready_to_dispatch','dispatching','dispatched','acquiring',
  'persisting','persisted','reconciling','completed','failed_not_applied',
  'recovery_required','compromised','revoked','abandoned'
));

CREATE TABLE operation_bound_protected_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protected_operation_id uuid NOT NULL REFERENCES protected_operations(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  semantic text NOT NULL CHECK(semantic ~ '^[a-z][a-z0-9_]{0,99}$'),
  generator_contract text NOT NULL CHECK(generator_contract ~ '^[a-z][a-z0-9_]{0,99}$'),
  generator_version integer NOT NULL CHECK(generator_version > 0),
  purpose text NOT NULL CHECK(purpose ~ '^[a-z][a-z0-9_]{0,99}$'),
  ciphertext bytea,
  initialization_vector bytea,
  authentication_tag bytea,
  lifecycle text NOT NULL CHECK(lifecycle IN ('active','sealed','invalidated','destroyed')),
  commitment text NOT NULL CHECK(commitment ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  sealed_at timestamptz,
  destroyed_at timestamptz,
  UNIQUE(protected_operation_id,semantic),
  CHECK(
    (lifecycle IN ('active','sealed') AND ciphertext IS NOT NULL AND initialization_vector IS NOT NULL AND authentication_tag IS NOT NULL)
    OR (lifecycle IN ('invalidated','destroyed') AND ciphertext IS NULL AND initialization_vector IS NULL AND authentication_tag IS NULL)
  )
);

CREATE INDEX operation_bound_protected_inputs_owner_idx
  ON operation_bound_protected_inputs(protected_operation_id,lifecycle);

ALTER TABLE protected_operations ADD COLUMN synthetic_input_set_commitment text
  CHECK(synthetic_input_set_commitment IS NULL OR synthetic_input_set_commitment ~ '^[a-f0-9]{64}$');
ALTER TABLE protected_operations ADD COLUMN payload_commitment text
  CHECK(payload_commitment IS NULL OR payload_commitment ~ '^[a-f0-9]{64}$');
ALTER TABLE protected_operations ADD COLUMN provider_idempotency_commitment text
  CHECK(provider_idempotency_commitment IS NULL OR provider_idempotency_commitment ~ '^[a-f0-9]{64}$');
ALTER TABLE adaptive_sessions ADD COLUMN trusted_dispatch_disposition text NOT NULL DEFAULT 'execute'
  CHECK(trusted_dispatch_disposition IN ('execute','qualification_only'));

CREATE OR REPLACE FUNCTION protect_operation_bound_input_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.protected_operation_id<>NEW.protected_operation_id
     OR OLD.project_id<>NEW.project_id OR OLD.environment_id<>NEW.environment_id
     OR OLD.semantic<>NEW.semantic OR OLD.generator_contract<>NEW.generator_contract
     OR OLD.generator_version<>NEW.generator_version OR OLD.purpose<>NEW.purpose
     OR OLD.commitment<>NEW.commitment THEN
    RAISE EXCEPTION 'Operation-bound protected input identity is immutable';
  END IF;
  IF OLD.lifecycle<>'active' AND NEW.lifecycle<>OLD.lifecycle THEN
    RAISE EXCEPTION 'Terminal operation-bound protected input is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER operation_bound_protected_inputs_immutable
  BEFORE UPDATE ON operation_bound_protected_inputs
  FOR EACH ROW EXECUTE FUNCTION protect_operation_bound_input_immutability();

-- Security-owned capability grant for the single established Vitract Test environment.
-- Existing and future environments remain default-deny.
UPDATE environments
SET policy=jsonb_set(
  policy,
  '{protectedSyntheticInputs}',
  '{"enabled":true,"generators":[
    {"contract":"reserved_test_email","version":1,"purposes":["test_order_qualification"],"resourceScopes":[{"resourceKind":"order","operation":"create"}]},
    {"contract":"synthetic_person_name","version":1,"purposes":["test_order_qualification"],"resourceScopes":[{"resourceKind":"order","operation":"create"}]},
    {"contract":"sandbox_shipping_address_json","version":1,"purposes":["test_order_qualification"],"resourceScopes":[{"resourceKind":"order","operation":"create"}]},
    {"contract":"opaque_operation_token","version":1,"purposes":["test_order_qualification"],"resourceScopes":[{"resourceKind":"order","operation":"create"}]}
  ]}'::jsonb,
  true
)
WHERE id='9a581bb0-2276-4888-9ddb-07b2485cddc3'::uuid
  AND project_id='6b3b5011-0f41-430c-a8a2-d4abfd9ff3f1'::uuid;
