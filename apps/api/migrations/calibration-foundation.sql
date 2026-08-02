DO $$
DECLARE has_decisions boolean := false;
BEGIN
  IF to_regclass('public.calibration_revision_decisions') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM calibration_revision_decisions)' INTO has_decisions;
  END IF;
  IF has_decisions THEN
    RAISE EXCEPTION 'Calibration cutoff refused: decisions exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM flow_revisions
    WHERE jsonb_path_exists(plan, '$.steps[*].action.calibrationContractRevisionId')
  ) THEN
    RAISE EXCEPTION 'Calibration cutoff refused: a Flow binds the retired calibration model';
  END IF;
END $$;

DROP TABLE IF EXISTS calibration_outbox CASCADE;
DROP TABLE IF EXISTS calibration_runs CASCADE;
DROP TABLE IF EXISTS calibration_revision_decisions CASCADE;
DROP TABLE IF EXISTS protected_operation_contract_revisions CASCADE;
DROP TABLE IF EXISTS protected_operation_contracts CASCADE;

CREATE TABLE calibration_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE RESTRICT, objective_id uuid NOT NULL REFERENCES mission_objectives(id) ON DELETE RESTRICT,
  agent_session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  name text NOT NULL, latest_revision_id uuid NOT NULL, created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id, name), UNIQUE(id, project_id)
);
CREATE TABLE calibration_contract_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES calibration_contracts(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  revision integer NOT NULL CHECK (revision > 0), source_flow_revision_id uuid NOT NULL REFERENCES flow_revisions(id) ON DELETE RESTRICT,
  source_step_id text NOT NULL, operation_id text NOT NULL, operation_digest text NOT NULL CHECK (operation_digest ~ '^[a-f0-9]{64}$'),
  input_schema_digest text NOT NULL CHECK (input_schema_digest ~ '^[a-f0-9]{64}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  operation_snapshot jsonb NOT NULL, environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  allowed_origins jsonb NOT NULL, created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(contract_id, revision), UNIQUE(id, contract_id)
);
ALTER TABLE calibration_contracts ADD CONSTRAINT calibration_contracts_latest_revision_fk
  FOREIGN KEY (latest_revision_id, id) REFERENCES calibration_contract_revisions(id, contract_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE OR REPLACE FUNCTION reject_calibration_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'calibration history is immutable'; END $$;
CREATE TRIGGER calibration_contract_revisions_immutable BEFORE UPDATE OR DELETE ON calibration_contract_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_mutation();

CREATE TABLE calibration_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE RESTRICT, objective_id uuid NOT NULL REFERENCES mission_objectives(id) ON DELETE RESTRICT,
  agent_session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  contract_revision_id uuid NOT NULL REFERENCES calibration_contract_revisions(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL, request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'), state text NOT NULL CHECK (state IN (
    'requested','queued','claimed','preparing','executing_preflight','boundary_reached','arming_privacy',
    'capsule_bootstrapping','preparation_running','preparation_verified','executing_protected_transaction','verifying_safe_exit','scanning_channels','attested','failed','cancelled',
    'expired','sealed','mutation_outcome_unknown')),
  disposable_data_confirmed boolean NOT NULL CHECK (disposable_data_confirmed), current_attempt_id uuid,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, UNIQUE(project_id, idempotency_key)
);
CREATE TABLE calibration_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0), state text NOT NULL CHECK (state IN ('claimed','running','attested','failed','cancelled','sealed','mutation_outcome_unknown')),
  worker_id text NOT NULL, claim_token uuid NOT NULL, release_id text NOT NULL, schema_fingerprint text NOT NULL,
  mutation_state text NOT NULL CHECK (mutation_state IN ('not_started','started','completed','unknown')) DEFAULT 'not_started',
  mutation_count integer NOT NULL DEFAULT 0 CHECK (mutation_count BETWEEN 0 AND 1), failure_provenance text,
  reason_code text, safe_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb, heartbeat_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(session_id, attempt_number), UNIQUE(id, session_id)
);
ALTER TABLE calibration_sessions ADD CONSTRAINT calibration_sessions_current_attempt_fk
  FOREIGN KEY (current_attempt_id, id) REFERENCES calibration_attempts(id, session_id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX calibration_attempts_one_active_idx ON calibration_attempts(session_id)
  WHERE state IN ('claimed','running');

CREATE TABLE calibration_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_revision_id uuid NOT NULL REFERENCES calibration_contract_revisions(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL UNIQUE REFERENCES calibration_attempts(id) ON DELETE RESTRICT,
  operation_digest text NOT NULL CHECK (operation_digest ~ '^[a-f0-9]{64}$'), boundary_fingerprint text NOT NULL CHECK (boundary_fingerprint ~ '^[a-f0-9]{64}$'),
  input_schema_digest text NOT NULL CHECK (input_schema_digest ~ '^[a-f0-9]{64}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  boundary_structure jsonb NOT NULL, protection_result jsonb NOT NULL, extraction_result jsonb NOT NULL,
  safe_exit_result jsonb NOT NULL, privacy_verified boolean NOT NULL, canary_scan_passed boolean NOT NULL,
  mutation_count integer NOT NULL CHECK (mutation_count = 1), release_id text NOT NULL, schema_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER calibration_attestations_immutable BEFORE UPDATE OR DELETE ON calibration_attestations
  FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_mutation();
CREATE TABLE calibration_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attestation_id uuid NOT NULL UNIQUE REFERENCES calibration_attestations(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')), actor_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  reason_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER calibration_decisions_immutable BEFORE UPDATE OR DELETE ON calibration_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_mutation();
CREATE TABLE calibration_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attestation_id uuid NOT NULL UNIQUE REFERENCES calibration_attestations(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER calibration_revocations_immutable BEFORE UPDATE OR DELETE ON calibration_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_mutation();
CREATE TABLE calibration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  sequence integer NOT NULL, type text NOT NULL, step_id text, phase text NOT NULL, code text,
  failure_provenance text, safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, sequence)
);
CREATE TRIGGER calibration_events_immutable BEFORE UPDATE OR DELETE ON calibration_events
  FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_mutation();
CREATE TABLE calibration_outbox (
  calibration_session_id uuid PRIMARY KEY REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  release_id text NOT NULL, schema_fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, publish_attempts integer NOT NULL DEFAULT 0, last_error text
);
CREATE INDEX calibration_contracts_project_idx ON calibration_contracts(project_id, created_at DESC);
CREATE INDEX calibration_sessions_project_idx ON calibration_sessions(project_id, created_at DESC);
CREATE INDEX calibration_attempts_heartbeat_idx ON calibration_attempts(state, heartbeat_at);
