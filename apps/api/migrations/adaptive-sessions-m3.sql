CREATE TABLE IF NOT EXISTS adaptive_sessions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN (
    'created','provisioning','active','suspended','completed','failed','cancelled','recovery_required'
  )),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  next_operation_sequence integer NOT NULL DEFAULT 1 CHECK (next_operation_sequence > 0),
  objective text NOT NULL,
  allowed_origins jsonb NOT NULL,
  decision_boundary jsonb,
  mission_id uuid REFERENCES missions(id) ON DELETE SET NULL,
  objective_id uuid REFERENCES mission_objectives(id) ON DELETE SET NULL,
  flow_draft_id uuid REFERENCES flow_drafts(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (project_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS adaptive_session_events (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  type text NOT NULL CHECK (type IN (
    'session_created','provisioning_started','session_activated','session_suspended',
    'session_resumed','session_completed','session_failed','session_cancelled',
    'recovery_required','operation_started','operation_completed','operation_failed',
    'decision_boundary_reached'
  )),
  safe_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS adaptive_session_runtime_leases (
  session_id uuid PRIMARY KEY REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL,
  fencing_token integer NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  lease_expires_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS adaptive_operations (
  session_id uuid NOT NULL REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  operation_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  mode text NOT NULL CHECK (mode IN ('observe','rehearse','transact','certify','run')),
  state text NOT NULL CHECK (state IN ('pending','running','completed','failed')),
  semantic_intent jsonb NOT NULL,
  expected_effect jsonb NOT NULL,
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  observation_epoch integer CHECK (observation_epoch >= 0),
  candidate_decision_digest text CHECK (
    candidate_decision_digest IS NULL OR candidate_decision_digest ~ '^[a-f0-9]{64}$'
  ),
  capability_manifest_digest text CHECK (
    capability_manifest_digest IS NULL OR capability_manifest_digest ~ '^[a-f0-9]{64}$'
  ),
  dispatch_boundary text NOT NULL DEFAULT 'not_dispatched' CHECK (
    dispatch_boundary IN ('not_dispatched','dispatching','dispatched','acknowledged')
  ),
  mutation_outcome text CHECK (mutation_outcome IN ('not_applied','applied','unknown')),
  functional_result text CHECK (functional_result IN ('succeeded','failed','inconclusive')),
  privacy_result text CHECK (privacy_result IN ('verified','unverified','degraded','sealed')),
  evidence_result jsonb,
  quality_findings jsonb,
  safe_outcome jsonb,
  decision_boundary jsonb,
  idempotency_key text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (session_id, operation_id),
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS adaptive_observations (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  operation_id text NOT NULL,
  document_epoch integer NOT NULL CHECK (document_epoch >= 0),
  safe_summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, operation_id)
    REFERENCES adaptive_operations(session_id, operation_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS adaptive_decision_boundaries (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  operation_id text,
  sequence integer NOT NULL CHECK (sequence > 0),
  boundary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);

CREATE TABLE IF NOT EXISTS adaptive_trajectories (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  trajectory_digest text NOT NULL CHECK (trajectory_digest ~ '^[a-f0-9]{64}$'),
  safe_trajectory jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, version),
  UNIQUE (session_id, trajectory_digest)
);

CREATE INDEX IF NOT EXISTS adaptive_sessions_project_updated_idx
  ON adaptive_sessions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS adaptive_session_events_order_idx
  ON adaptive_session_events(session_id, sequence);
CREATE INDEX IF NOT EXISTS adaptive_operations_order_idx
  ON adaptive_operations(session_id, sequence);
CREATE INDEX IF NOT EXISTS adaptive_session_runtime_leases_expiry_idx
  ON adaptive_session_runtime_leases(lease_expires_at);

CREATE OR REPLACE FUNCTION protect_adaptive_append_only_row()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Adaptive session journal is append-only';
END $$;

DROP TRIGGER IF EXISTS adaptive_session_events_append_only ON adaptive_session_events;
CREATE TRIGGER adaptive_session_events_append_only
  BEFORE UPDATE OR DELETE ON adaptive_session_events
  FOR EACH ROW EXECUTE FUNCTION protect_adaptive_append_only_row();

DROP TRIGGER IF EXISTS adaptive_observations_append_only ON adaptive_observations;
CREATE TRIGGER adaptive_observations_append_only
  BEFORE UPDATE OR DELETE ON adaptive_observations
  FOR EACH ROW EXECUTE FUNCTION protect_adaptive_append_only_row();

DROP TRIGGER IF EXISTS adaptive_decision_boundaries_append_only ON adaptive_decision_boundaries;
CREATE TRIGGER adaptive_decision_boundaries_append_only
  BEFORE UPDATE OR DELETE ON adaptive_decision_boundaries
  FOR EACH ROW EXECUTE FUNCTION protect_adaptive_append_only_row();

DROP TRIGGER IF EXISTS adaptive_trajectories_append_only ON adaptive_trajectories;
CREATE TRIGGER adaptive_trajectories_append_only
  BEFORE UPDATE OR DELETE ON adaptive_trajectories
  FOR EACH ROW EXECUTE FUNCTION protect_adaptive_append_only_row();

CREATE OR REPLACE FUNCTION protect_adaptive_operation_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Adaptive operations cannot be deleted';
  END IF;
  IF OLD.state IN ('completed','failed') THEN
    RAISE EXCEPTION 'Terminal adaptive operations are immutable';
  END IF;
  IF NEW.session_id<>OLD.session_id OR NEW.operation_id<>OLD.operation_id
     OR NEW.sequence<>OLD.sequence OR NEW.mode<>OLD.mode
     OR NEW.semantic_intent<>OLD.semantic_intent OR NEW.expected_effect<>OLD.expected_effect
     OR NEW.policy_digest<>OLD.policy_digest OR NEW.started_at<>OLD.started_at THEN
    RAISE EXCEPTION 'Adaptive operation identity is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS adaptive_operations_identity_immutable ON adaptive_operations;
CREATE TRIGGER adaptive_operations_identity_immutable
  BEFORE UPDATE OR DELETE ON adaptive_operations
  FOR EACH ROW EXECUTE FUNCTION protect_adaptive_operation_identity();
