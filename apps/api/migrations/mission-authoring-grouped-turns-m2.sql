-- M2 forward-only foundation for server-owned Mission authoring turns.

ALTER TABLE flow_drafts ADD COLUMN IF NOT EXISTS purpose text;
UPDATE flow_drafts SET purpose='primary' WHERE purpose IS NULL;
ALTER TABLE flow_drafts ALTER COLUMN purpose SET DEFAULT 'primary';
ALTER TABLE flow_drafts ALTER COLUMN purpose SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='flow_drafts_purpose_check') THEN
    ALTER TABLE flow_drafts ADD CONSTRAINT flow_drafts_purpose_check
      CHECK (purpose IN ('setup','primary','acceptance','diagnostic','reconciliation','cleanup'));
  END IF;
END $$;

ALTER TABLE adaptive_sessions
  ADD COLUMN IF NOT EXISTS active_objective_id uuid,
  ADD COLUMN IF NOT EXISTS active_flow_draft_id uuid,
  ADD COLUMN IF NOT EXISTS authoring_turn_budgets jsonb,
  ADD COLUMN IF NOT EXISTS protected_reference_allowlist jsonb;

UPDATE adaptive_sessions
SET active_objective_id=objective_id,
    active_flow_draft_id=flow_draft_id
WHERE active_objective_id IS NULL OR active_flow_draft_id IS NULL;

UPDATE adaptive_sessions
SET authoring_turn_budgets=COALESCE(authoring_turn_budgets, '{"maxOperations":20,"maxDurationMs":60000}'::jsonb),
    protected_reference_allowlist=COALESCE(protected_reference_allowlist, '[]'::jsonb)
WHERE authoring_turn_budgets IS NULL OR protected_reference_allowlist IS NULL;

ALTER TABLE adaptive_sessions
  ALTER COLUMN authoring_turn_budgets SET NOT NULL,
  ALTER COLUMN protected_reference_allowlist SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='adaptive_sessions_active_objective_owner_fk') THEN
    ALTER TABLE adaptive_sessions ADD CONSTRAINT adaptive_sessions_active_objective_owner_fk
      FOREIGN KEY(active_objective_id,mission_id)
      REFERENCES mission_objectives(id,mission_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='adaptive_sessions_active_flow_owner_fk') THEN
    ALTER TABLE adaptive_sessions ADD CONSTRAINT adaptive_sessions_active_flow_owner_fk
      FOREIGN KEY(active_flow_draft_id,mission_id,active_objective_id)
      REFERENCES flow_drafts(id,mission_id,objective_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='adaptive_sessions_active_owner_required_check') THEN
    ALTER TABLE adaptive_sessions ADD CONSTRAINT adaptive_sessions_active_owner_required_check CHECK (
      state IN ('completed','failed','cancelled') OR
      (active_objective_id IS NOT NULL AND active_flow_draft_id IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='adaptive_sessions_id_mission_unique') THEN
    ALTER TABLE adaptive_sessions ADD CONSTRAINT adaptive_sessions_id_mission_unique UNIQUE (id,mission_id);
  END IF;
END $$;

ALTER TABLE adaptive_operations
  ADD COLUMN IF NOT EXISTS mission_id uuid,
  ADD COLUMN IF NOT EXISTS objective_id uuid,
  ADD COLUMN IF NOT EXISTS flow_draft_id uuid,
  ADD COLUMN IF NOT EXISTS authoring_intent jsonb,
  ADD COLUMN IF NOT EXISTS derived_action jsonb;

-- The forward-only ownership backfill must qualify historical terminal rows. Keep
-- the immutable runtime trigger absent only for this transactional migration.
DROP TRIGGER IF EXISTS adaptive_operations_identity_immutable ON adaptive_operations;

UPDATE adaptive_operations operation
SET mission_id=session.mission_id,
    objective_id=session.active_objective_id,
    flow_draft_id=session.active_flow_draft_id,
    authoring_intent=COALESCE(operation.authoring_intent, operation.semantic_intent),
    derived_action=COALESCE(operation.derived_action, operation.semantic_intent)
FROM adaptive_sessions session
WHERE session.id=operation.session_id
  AND (
    operation.mission_id IS NULL OR operation.objective_id IS NULL OR operation.flow_draft_id IS NULL
    OR operation.authoring_intent IS NULL OR operation.derived_action IS NULL
  );

-- M1 conservatively cancelled ownerless legacy sessions. Settle operations that
-- those sessions left nonterminal so M2 can never redispatch them.
UPDATE adaptive_operations operation
SET state='failed',
    functional_result='inconclusive',
    mutation_outcome='unknown',
    safe_outcome=jsonb_build_object(
      'operationId',operation.operation_id,
      'functionalResult','inconclusive',
      'mutationOutcome','unknown',
      'privacyResult','unverified',
      'evidenceResult','[]'::jsonb,
      'qualityFindings','[]'::jsonb,
      'durationMs',0,
      'reasonCode','LEGACY_OPERATION_UNOWNED_AT_M2_CUTOVER'
    ),
    decision_boundary=jsonb_build_object(
      'type','mutation_reconciliation_required',
      'reasonCode','LEGACY_OPERATION_UNOWNED_AT_M2_CUTOVER',
      'safeActions',jsonb_build_array()
    ),
    completed_at=COALESCE(operation.completed_at,now())
FROM adaptive_sessions session
WHERE operation.session_id=session.id
  AND (session.mission_id IS NULL OR session.objective_id IS NULL OR session.flow_draft_id IS NULL)
  AND operation.state IN ('pending','running');

ALTER TABLE adaptive_operations
  ALTER COLUMN authoring_intent SET NOT NULL,
  ALTER COLUMN derived_action SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='adaptive_operations_required_owner_check') THEN
    ALTER TABLE adaptive_operations ADD CONSTRAINT adaptive_operations_required_owner_check CHECK (
      state IN ('completed','failed') OR
      (mission_id IS NOT NULL AND objective_id IS NOT NULL AND flow_draft_id IS NOT NULL)
    );
  END IF;
END $$;

ALTER TABLE adaptive_operations DROP CONSTRAINT IF EXISTS adaptive_operations_session_active_owner_fk;
ALTER TABLE adaptive_sessions DROP CONSTRAINT IF EXISTS adaptive_sessions_active_owner_unique;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='adaptive_operations_session_mission_fk') THEN
    ALTER TABLE adaptive_operations ADD CONSTRAINT adaptive_operations_session_mission_fk
      FOREIGN KEY(session_id,mission_id)
      REFERENCES adaptive_sessions(id,mission_id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='adaptive_operations_flow_owner_fk') THEN
    ALTER TABLE adaptive_operations ADD CONSTRAINT adaptive_operations_flow_owner_fk
      FOREIGN KEY(flow_draft_id,mission_id,objective_id)
      REFERENCES flow_drafts(id,mission_id,objective_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS mission_authoring_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  safe_input jsonb NOT NULL,
  continuation_idempotency_key text,
  continuation_input_digest text,
  next_intent_index integer NOT NULL DEFAULT 0 CHECK(next_intent_index >= 0),
  state text NOT NULL CHECK(state IN ('running','completed','decision_required','pending','failed')),
  budgets jsonb NOT NULL,
  safe_response jsonb,
  current_phase text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(session_id,idempotency_key),
  UNIQUE(session_id,continuation_idempotency_key),
  CHECK (
    (continuation_idempotency_key IS NULL AND continuation_input_digest IS NULL) OR
    (continuation_idempotency_key IS NOT NULL AND continuation_input_digest ~ '^[a-f0-9]{64}$')
  ),
  CHECK (next_intent_index <= jsonb_array_length(safe_input->'intents')),
  CHECK (
    (state='running' AND safe_response IS NULL AND current_phase IS NOT NULL AND completed_at IS NULL) OR
    (state='pending' AND safe_response IS NOT NULL AND current_phase IS NOT NULL AND completed_at IS NULL) OR
    (state IN ('completed','decision_required','failed') AND safe_response IS NOT NULL AND completed_at IS NOT NULL)
  )
);

ALTER TABLE mission_authoring_turns
  ADD COLUMN IF NOT EXISTS continuation_input_digest text,
  ADD COLUMN IF NOT EXISTS next_intent_index integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS mission_authoring_session_flows (
  session_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  flow_draft_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('setup','primary','acceptance','diagnostic','reconciliation','cleanup')),
  sequence integer NOT NULL CHECK(sequence > 0),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,flow_draft_id),
  UNIQUE(session_id,sequence),
  FOREIGN KEY(session_id,mission_id) REFERENCES adaptive_sessions(id,mission_id) ON DELETE RESTRICT,
  FOREIGN KEY(objective_id,mission_id) REFERENCES mission_objectives(id,mission_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_draft_id,mission_id,objective_id)
    REFERENCES flow_drafts(id,mission_id,objective_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS mission_authoring_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence > 0),
  idempotency_key text NOT NULL,
  source_objective_id uuid NOT NULL,
  source_flow_draft_id uuid NOT NULL,
  target_objective_id uuid NOT NULL,
  target_flow_draft_id uuid NOT NULL,
  reason text NOT NULL,
  state text NOT NULL CHECK(state IN ('started','completed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(session_id,sequence),
  UNIQUE(session_id,idempotency_key),
  CHECK(source_flow_draft_id <> target_flow_draft_id),
  FOREIGN KEY(session_id,mission_id) REFERENCES adaptive_sessions(id,mission_id) ON DELETE RESTRICT,
  FOREIGN KEY(source_objective_id,mission_id) REFERENCES mission_objectives(id,mission_id) ON DELETE RESTRICT,
  FOREIGN KEY(target_objective_id,mission_id) REFERENCES mission_objectives(id,mission_id) ON DELETE RESTRICT,
  FOREIGN KEY(source_flow_draft_id,mission_id,source_objective_id)
    REFERENCES flow_drafts(id,mission_id,objective_id) ON DELETE RESTRICT,
  FOREIGN KEY(target_flow_draft_id,mission_id,target_objective_id)
    REFERENCES flow_drafts(id,mission_id,objective_id) ON DELETE RESTRICT
);

ALTER TABLE adaptive_session_events DROP CONSTRAINT IF EXISTS adaptive_session_events_type_check;
ALTER TABLE flow_draft_events DROP CONSTRAINT IF EXISTS flow_draft_events_type_check;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='adaptive_session_events_type_check') THEN
    ALTER TABLE adaptive_session_events ADD CONSTRAINT adaptive_session_events_type_check CHECK(type IN (
      'session_created','provisioning_started','session_activated','session_suspended',
      'session_resumed','session_completed','session_failed','session_cancelled',
      'recovery_required','operation_started','operation_completed','operation_failed',
      'decision_boundary_reached','turn_started','turn_completed','flow_handoff_started',
      'flow_handoff_completed','session_closed'
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='flow_draft_events_type_check') THEN
    ALTER TABLE flow_draft_events ADD CONSTRAINT flow_draft_events_type_check CHECK(type IN (
      'created','updated','probe_started','probe_completed','compilation_started',
      'compilation_completed','published','abandoned','authoring_step_appended'
    ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS mission_authoring_turns_replay_idx
  ON mission_authoring_turns(session_id,idempotency_key,state);
CREATE UNIQUE INDEX IF NOT EXISTS mission_authoring_turns_one_active_per_session_idx
  ON mission_authoring_turns(session_id)
  WHERE state IN ('running','pending');
CREATE INDEX IF NOT EXISTS adaptive_sessions_active_flow_idx
  ON adaptive_sessions(mission_id,active_objective_id,active_flow_draft_id,updated_at DESC);

DROP TRIGGER IF EXISTS adaptive_operations_identity_immutable ON adaptive_operations;
CREATE TRIGGER adaptive_operations_identity_immutable
  BEFORE UPDATE OR DELETE ON adaptive_operations
  FOR EACH ROW EXECUTE FUNCTION protect_adaptive_operation_identity();
CREATE INDEX IF NOT EXISTS mission_authoring_session_flows_listing_idx
  ON mission_authoring_session_flows(mission_id,objective_id,purpose,sequence);
CREATE INDEX IF NOT EXISTS mission_authoring_handoffs_listing_idx
  ON mission_authoring_handoffs(mission_id,session_id,sequence);
