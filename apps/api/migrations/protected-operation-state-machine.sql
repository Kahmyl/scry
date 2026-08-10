ALTER TABLE adaptive_sessions ADD COLUMN IF NOT EXISTS agent_session_id uuid;
UPDATE adaptive_sessions session SET agent_session_id=draft.created_by_agent_session_id
FROM flow_drafts draft WHERE draft.id=session.flow_draft_id AND session.agent_session_id IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='adaptive_sessions_agent_mission_fk') THEN
    ALTER TABLE adaptive_sessions ADD CONSTRAINT adaptive_sessions_agent_mission_fk
      FOREIGN KEY(agent_session_id,mission_id) REFERENCES agent_sessions(id,mission_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS protected_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id text NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 200),
  mutation_identity text NOT NULL CHECK(length(mutation_identity) BETWEEN 8 AND 200),
  owner_kind text NOT NULL CHECK(owner_kind IN ('authoring_session','run')),
  authoring_session_id uuid REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES runs(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  objective_id uuid NOT NULL,
  agent_session_id uuid NOT NULL,
  flow_draft_id uuid REFERENCES flow_drafts(id) ON DELETE RESTRICT,
  flow_revision_id uuid REFERENCES flow_revisions(id) ON DELETE RESTRICT,
  authorization_id uuid REFERENCES mission_authorizations(id) ON DELETE RESTRICT,
  program_digest text NOT NULL CHECK(program_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN (
    'planned','preparing','ready_to_dispatch','dispatching','dispatched','acquiring',
    'persisting','persisted','reconciling','completed','failed_not_applied',
    'recovery_required','compromised','revoked','abandoned'
  )),
  phase text NOT NULL CHECK(length(phase) BETWEEN 1 AND 100),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  dispatch_state text NOT NULL DEFAULT 'not_started' CHECK(dispatch_state IN ('not_started','authorized','started','acknowledged')),
  mutation_outcome text NOT NULL DEFAULT 'not_attempted' CHECK(mutation_outcome IN ('not_attempted','not_applied','applied','unknown')),
  acquisition_state text NOT NULL DEFAULT 'not_started' CHECK(acquisition_state IN ('not_started','running','complete','failed')),
  persistence_state text NOT NULL DEFAULT 'not_started' CHECK(persistence_state IN ('not_started','running','committed','failed','uncertain')),
  safe_output_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  persisted_references jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code text CHECK(failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]*$'),
  recovery_class text CHECK(recovery_class IS NULL OR recovery_class IN ('safe_to_retry','reconciliation_required','secure_assistance','revoke','do_not_retry')),
  safe_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  phase_timings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK(
    (owner_kind='authoring_session' AND authoring_session_id IS NOT NULL AND run_id IS NULL AND flow_draft_id IS NOT NULL AND authorization_id IS NOT NULL)
    OR (owner_kind='run' AND run_id IS NOT NULL AND authoring_session_id IS NULL AND flow_revision_id IS NOT NULL)
  ),
  CHECK(safe_output_manifest::text !~* '(plaintext|clipboard|selector|xpath|runtime.?id|fingerprint|handle|outerhtml|innerhtml|dom)'),
  CHECK(persisted_references::text !~* '(plaintext|clipboard|selector|xpath|runtime.?id|fingerprint|handle|outerhtml|innerhtml|dom)'),
  CHECK(safe_diagnostics::text !~* '(plaintext|clipboard|selector|xpath|runtime.?id|fingerprint|handle|outerhtml|innerhtml|dom)'),
  FOREIGN KEY(objective_id,mission_id) REFERENCES mission_objectives(id,mission_id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_session_id,mission_id) REFERENCES agent_sessions(id,mission_id) ON DELETE RESTRICT,
  UNIQUE(owner_kind,authoring_session_id,operation_id),
  UNIQUE(owner_kind,run_id,operation_id),
  UNIQUE(id,version)
);

CREATE TABLE IF NOT EXISTS protected_operation_transitions (
  id bigserial PRIMARY KEY,
  protected_operation_id uuid NOT NULL REFERENCES protected_operations(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK(sequence > 0),
  from_state text,
  to_state text NOT NULL,
  phase text NOT NULL CHECK(length(phase) BETWEEN 1 AND 100),
  fencing_token bigint NOT NULL CHECK(fencing_token >= 0),
  reason_code text CHECK(reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]*$'),
  safe_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(protected_operation_id,sequence),
  CHECK(safe_diagnostics::text !~* '(plaintext|clipboard|selector|xpath|runtime.?id|fingerprint|handle|outerhtml|innerhtml|dom)')
);

CREATE INDEX IF NOT EXISTS protected_operations_owner_state_idx
  ON protected_operations(owner_kind,authoring_session_id,run_id,state,updated_at);
CREATE INDEX IF NOT EXISTS protected_operations_lease_idx
  ON protected_operations(state,lease_expires_at) WHERE completed_at IS NULL;

ALTER TABLE project_credentials
  ADD COLUMN IF NOT EXISTS origin_protected_operation_id uuid REFERENCES protected_operations(id) ON DELETE RESTRICT;

ALTER TABLE credential_incidents ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE credential_incidents
  ADD COLUMN IF NOT EXISTS protected_operation_id uuid REFERENCES protected_operations(id) ON DELETE RESTRICT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='credential_incidents_operation_owner_check') THEN
    ALTER TABLE credential_incidents ADD CONSTRAINT credential_incidents_operation_owner_check CHECK (
      (run_id IS NOT NULL AND protected_operation_id IS NULL)
      OR (run_id IS NULL AND protected_operation_id IS NOT NULL)
    );
  END IF;
END $$;

DROP INDEX IF EXISTS generated_public_values_transaction_reference_unique;
ALTER TABLE generated_public_values ALTER COLUMN source_run_id DROP NOT NULL;
ALTER TABLE generated_public_values
  ADD COLUMN IF NOT EXISTS source_protected_operation_id uuid REFERENCES protected_operations(id) ON DELETE RESTRICT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='generated_public_values_source_owner_check') THEN
    ALTER TABLE generated_public_values
      ADD CONSTRAINT generated_public_values_source_owner_check CHECK (
        (source_run_id IS NOT NULL AND source_protected_operation_id IS NULL)
        OR (source_run_id IS NULL AND source_protected_operation_id IS NOT NULL)
      );
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS generated_public_values_run_transaction_reference_unique
  ON generated_public_values(source_run_id,operation_id,reference) WHERE source_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS generated_public_values_protected_operation_reference_unique
  ON generated_public_values(source_protected_operation_id,reference) WHERE source_protected_operation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_protected_operation_transition_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Protected operation transition history is append-only';
END $$;
DROP TRIGGER IF EXISTS protected_operation_transitions_append_only ON protected_operation_transitions;
CREATE TRIGGER protected_operation_transitions_append_only
  BEFORE UPDATE OR DELETE ON protected_operation_transitions
  FOR EACH ROW EXECUTE FUNCTION protect_protected_operation_transition_history();
