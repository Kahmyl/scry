-- Append-only authoritative reconciliation for post-dispatch adaptive UNKNOWN outcomes.
ALTER TABLE adaptive_session_events DROP CONSTRAINT IF EXISTS adaptive_session_events_type_check;
ALTER TABLE adaptive_session_events ADD CONSTRAINT adaptive_session_events_type_check CHECK(type IN (
  'session_created','provisioning_started','session_activated','session_suspended',
  'session_resumed','session_completed','session_failed','session_cancelled',
  'recovery_required','operation_started','operation_completed','operation_failed',
  'decision_boundary_reached','turn_started','turn_completed','flow_handoff_started',
  'flow_handoff_completed','session_closed','reconciliation_started','reconciliation_completed'
));

CREATE TABLE IF NOT EXISTS adaptive_operation_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  operation_id text NOT NULL,
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  objective_id uuid NOT NULL,
  flow_draft_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  attempt integer NOT NULL CHECK (attempt > 0),
  state text NOT NULL CHECK (state IN ('observing','completed')),
  strategy text NOT NULL CHECK (strategy IN ('browser_effect','authoritative_resource','unavailable')),
  expected_effect jsonb NOT NULL,
  original_outcome jsonb NOT NULL,
  evidence jsonb,
  result text CHECK (result IN ('proven_applied','proven_not_applied','still_unknown')),
  reason_code text,
  fencing_token integer NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY(session_id,operation_id)
    REFERENCES adaptive_operations(session_id,operation_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_draft_id,mission_id,objective_id)
    REFERENCES flow_drafts(id,mission_id,objective_id) ON DELETE RESTRICT,
  UNIQUE(session_id,operation_id,idempotency_key),
  UNIQUE(session_id,operation_id,attempt)
);

CREATE TABLE IF NOT EXISTS adaptive_operation_dispatch_baselines (
  session_id uuid NOT NULL,
  operation_id text NOT NULL,
  expected_effect jsonb NOT NULL,
  document_epoch integer NOT NULL CHECK(document_epoch>=0),
  url text NOT NULL,
  effect_state jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,operation_id),
  FOREIGN KEY(session_id,operation_id) REFERENCES adaptive_operations(session_id,operation_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION deny_adaptive_operation_dispatch_baseline_change()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'ADAPTIVE_OPERATION_DISPATCH_BASELINE_IMMUTABLE';
END $$;
DROP TRIGGER IF EXISTS adaptive_operation_dispatch_baseline_immutable ON adaptive_operation_dispatch_baselines;
CREATE TRIGGER adaptive_operation_dispatch_baseline_immutable BEFORE UPDATE OR DELETE
  ON adaptive_operation_dispatch_baselines FOR EACH ROW EXECUTE FUNCTION deny_adaptive_operation_dispatch_baseline_change();

CREATE UNIQUE INDEX IF NOT EXISTS adaptive_operation_reconciliation_observing_idx
  ON adaptive_operation_reconciliations(session_id,operation_id) WHERE state='observing';

CREATE INDEX IF NOT EXISTS adaptive_operation_reconciliation_mission_idx
  ON adaptive_operation_reconciliations(mission_id,session_id,operation_id,result);

CREATE OR REPLACE FUNCTION enforce_adaptive_operation_reconciliation_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ADAPTIVE_OPERATION_RECONCILIATION_IMMUTABLE'; END IF;
  IF OLD.state<>'observing' OR NEW.state<>'completed'
     OR NEW.session_id<>OLD.session_id OR NEW.operation_id<>OLD.operation_id
     OR NEW.mission_id<>OLD.mission_id OR NEW.objective_id<>OLD.objective_id
     OR NEW.flow_draft_id<>OLD.flow_draft_id OR NEW.idempotency_key<>OLD.idempotency_key
     OR NEW.request_digest<>OLD.request_digest OR NEW.attempt<>OLD.attempt
     OR NEW.strategy<>OLD.strategy OR NEW.expected_effect<>OLD.expected_effect
     OR NEW.original_outcome<>OLD.original_outcome OR NEW.result IS NULL
     OR NEW.reason_code IS NULL OR NEW.completed_at IS NULL
     OR NEW.fencing_token<>OLD.fencing_token+1 THEN
    RAISE EXCEPTION 'ADAPTIVE_OPERATION_RECONCILIATION_INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS adaptive_operation_reconciliation_immutable ON adaptive_operation_reconciliations;
CREATE TRIGGER adaptive_operation_reconciliation_immutable
  BEFORE UPDATE OR DELETE ON adaptive_operation_reconciliations
  FOR EACH ROW EXECUTE FUNCTION enforce_adaptive_operation_reconciliation_transition();

CREATE OR REPLACE FUNCTION adaptive_operation_unknown_unresolved(input_session_id uuid,input_operation_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM adaptive_operation_reconciliations reconciliation
     WHERE reconciliation.session_id=input_session_id
       AND reconciliation.operation_id=input_operation_id
       AND reconciliation.state='completed'
       AND reconciliation.result IN ('proven_applied','proven_not_applied')
  )
$$;

CREATE OR REPLACE VIEW unresolved_adaptive_unknown_operations AS
SELECT operation.*
  FROM adaptive_operations operation
 WHERE operation.mutation_outcome='unknown'
   AND NOT EXISTS (
     SELECT 1 FROM adaptive_operation_reconciliations reconciliation
      WHERE reconciliation.session_id=operation.session_id
        AND reconciliation.operation_id=operation.operation_id
        AND reconciliation.state='completed'
        AND reconciliation.result IN ('proven_applied','proven_not_applied')
   );
