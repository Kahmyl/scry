CREATE TABLE IF NOT EXISTS browser_runtime_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_id text NOT NULL, schema_fingerprint text NOT NULL,
  runtime_hash text NOT NULL CHECK(runtime_hash ~ '^[a-f0-9]{64}$'), capability_manifest_hash text NOT NULL CHECK(capability_manifest_hash ~ '^[a-f0-9]{64}$'),
  health jsonb NOT NULL, ready boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(release_id,schema_fingerprint,runtime_hash)
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS authoring_policy jsonb NOT NULL DEFAULT '{"authenticatedSessionReuse":false,"maximumSessionLeaseMs":28800000}'::jsonb;
ALTER TABLE mission_authorizations DROP CONSTRAINT IF EXISTS mission_authorizations_kind_check;
ALTER TABLE mission_authorizations ADD CONSTRAINT mission_authorizations_kind_check CHECK(kind IN ('live_read','live_mutation','protected_mutation','authentication_calibration'));

CREATE TABLE IF NOT EXISTS flow_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL, objective_id uuid NOT NULL, environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  flow_id uuid REFERENCES flows(id) ON DELETE SET NULL, name text NOT NULL, description text NOT NULL DEFAULT '', content jsonb NOT NULL,
  state text NOT NULL DEFAULT 'editing' CHECK(state IN ('editing','probing','compiling','publishable','published','abandoned')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), plan jsonb NOT NULL, created_by_agent_session_id uuid NOT NULL,
  published_revision_id uuid REFERENCES flow_revisions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(mission_id,project_id) REFERENCES missions(id,project_id) ON DELETE CASCADE,
  FOREIGN KEY(objective_id,mission_id) REFERENCES mission_objectives(id,mission_id) ON DELETE CASCADE,
  FOREIGN KEY(created_by_agent_session_id,mission_id) REFERENCES agent_sessions(id,mission_id) ON DELETE RESTRICT,
  UNIQUE(id,mission_id,objective_id), UNIQUE(project_id,id)
);
CREATE TABLE IF NOT EXISTS flow_draft_events (
  id bigserial PRIMARY KEY, draft_id uuid NOT NULL REFERENCES flow_drafts(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK(version>0), type text NOT NULL CHECK(type IN ('created','updated','probe_started','probe_completed','compilation_started','compilation_completed','published','abandoned')),
  agent_session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT, summary text NOT NULL,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION reject_authoring_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Authoring history is append-only'; END $$;
DROP TRIGGER IF EXISTS flow_draft_events_immutable ON flow_draft_events;
CREATE TRIGGER flow_draft_events_immutable BEFORE UPDATE OR DELETE ON flow_draft_events FOR EACH ROW EXECUTE FUNCTION reject_authoring_event_mutation();

CREATE TABLE IF NOT EXISTS probe_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid NOT NULL REFERENCES flow_drafts(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL, objective_id uuid NOT NULL, environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  draft_version integer NOT NULL CHECK(draft_version>0), level text NOT NULL CHECK(level IN ('inspection','reversible','calibration_transaction')),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','claimed','running','completed','failed','cancelled','timed_out')),
  authorization_id uuid REFERENCES mission_authorizations(id) ON DELETE RESTRICT, disposable_data_confirmed boolean NOT NULL DEFAULT false,
  created_by_agent_session_id uuid NOT NULL, idempotency_key text NOT NULL, result jsonb, failure_provenance text,
  reason_code text, current_attempt_id uuid, cancellation_requested_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz, completed_at timestamptz,
  FOREIGN KEY(draft_id,mission_id,objective_id) REFERENCES flow_drafts(id,mission_id,objective_id) ON DELETE CASCADE,
  FOREIGN KEY(created_by_agent_session_id,mission_id) REFERENCES agent_sessions(id,mission_id) ON DELETE RESTRICT,
  CHECK(level<>'calibration_transaction' OR (authorization_id IS NOT NULL AND disposable_data_confirmed)),
  UNIQUE(draft_id,idempotency_key), UNIQUE(id,mission_id,objective_id)
);
CREATE TABLE IF NOT EXISTS probe_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), probe_session_id uuid NOT NULL REFERENCES probe_sessions(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK(attempt_number>0), state text NOT NULL CHECK(state IN ('claimed','running','completed','failed','cancelled','timed_out')),
  worker_id text, claim_token uuid UNIQUE, heartbeat_at timestamptz, safe_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz, completed_at timestamptz, UNIQUE(probe_session_id,attempt_number)
);
ALTER TABLE probe_sessions DROP CONSTRAINT IF EXISTS probe_sessions_current_attempt_fk;
ALTER TABLE probe_sessions ADD CONSTRAINT probe_sessions_current_attempt_fk FOREIGN KEY(current_attempt_id) REFERENCES probe_attempts(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE IF NOT EXISTS probe_events (
  id bigserial PRIMARY KEY, probe_session_id uuid NOT NULL REFERENCES probe_sessions(id) ON DELETE CASCADE,
  sequence integer NOT NULL, type text NOT NULL, safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(), UNIQUE(probe_session_id,sequence)
);
DROP TRIGGER IF EXISTS probe_events_immutable ON probe_events;
CREATE TRIGGER probe_events_immutable BEFORE UPDATE OR DELETE ON probe_events FOR EACH ROW EXECUTE FUNCTION reject_authoring_event_mutation();
CREATE TABLE IF NOT EXISTS probe_outbox (
  probe_session_id uuid PRIMARY KEY REFERENCES probe_sessions(id) ON DELETE CASCADE, release_id text NOT NULL,
  schema_fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0, last_error text
);

CREATE TABLE IF NOT EXISTS authentication_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE, application_origin text NOT NULL, name text NOT NULL,
  latest_revision_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,environment_id,name), UNIQUE(id,project_id,environment_id)
);
CREATE TABLE IF NOT EXISTS authentication_contract_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES authentication_contracts(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  revision integer NOT NULL CHECK(revision>0), contract jsonb NOT NULL, structural_fingerprint text,
  created_by_agent_session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  expires_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(contract_id,revision), UNIQUE(id,contract_id)
);
ALTER TABLE authentication_contracts DROP CONSTRAINT IF EXISTS authentication_contracts_latest_revision_fk;
ALTER TABLE authentication_contracts ADD CONSTRAINT authentication_contracts_latest_revision_fk FOREIGN KEY(latest_revision_id,id) REFERENCES authentication_contract_revisions(id,contract_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE probe_sessions ADD COLUMN IF NOT EXISTS authentication_contract_revision_id uuid REFERENCES authentication_contract_revisions(id) ON DELETE RESTRICT;
CREATE TABLE IF NOT EXISTS authenticated_session_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, environment_id uuid NOT NULL,
  authentication_contract_revision_id uuid NOT NULL REFERENCES authentication_contract_revisions(id) ON DELETE CASCADE,
  origin text NOT NULL, runtime_hash text NOT NULL, structural_fingerprint text NOT NULL,
  ciphertext bytea NOT NULL, initialization_vector bytea NOT NULL, authentication_tag bytea NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','expired','revoked','invalidated')),
  lease_token uuid NOT NULL UNIQUE, expires_at timestamptz NOT NULL, last_validated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
-- The composite project/environment ownership is enforced by service queries because environments use (id, project_id).
ALTER TABLE authenticated_session_leases ADD CONSTRAINT authenticated_session_leases_environment_fk FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS flow_compilations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid NOT NULL REFERENCES flow_drafts(id) ON DELETE CASCADE,
  draft_version integer NOT NULL CHECK(draft_version>0), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL, objective_id uuid NOT NULL, environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  flow_revision_id uuid REFERENCES flow_revisions(id) ON DELETE CASCADE, probe_session_id uuid REFERENCES probe_sessions(id) ON DELETE RESTRICT,
  authentication_contract_revision_id uuid REFERENCES authentication_contract_revisions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK(status IN ('pending','execution_ready','calibration_required','invalid','runtime_unhealthy','stale','superseded')),
  plan_digest text NOT NULL CHECK(plan_digest ~ '^[a-f0-9]{64}$'), compiled_contract_digest text NOT NULL CHECK(compiled_contract_digest ~ '^[a-f0-9]{64}$'),
  capability_manifest_hash text NOT NULL CHECK(capability_manifest_hash ~ '^[a-f0-9]{64}$'), runtime_hash text NOT NULL CHECK(runtime_hash ~ '^[a-f0-9]{64}$'),
  page_fingerprint text, authentication_fingerprint text, target_contracts jsonb NOT NULL DEFAULT '[]'::jsonb,
  readiness_contracts jsonb NOT NULL DEFAULT '[]'::jsonb, diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  authorization_digest text NOT NULL, calibration_digest text NOT NULL, created_by_agent_session_id uuid NOT NULL,
  idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, invalidated_at timestamptz,
  FOREIGN KEY(draft_id,mission_id,objective_id) REFERENCES flow_drafts(id,mission_id,objective_id) ON DELETE CASCADE,
  FOREIGN KEY(created_by_agent_session_id,mission_id) REFERENCES agent_sessions(id,mission_id) ON DELETE RESTRICT,
  UNIQUE(draft_id,draft_version,idempotency_key), UNIQUE(id,mission_id,objective_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS flow_compilation_current_ready_idx ON flow_compilations(draft_id,draft_version) WHERE status='execution_ready';
ALTER TABLE mission_execution_bindings ADD COLUMN IF NOT EXISTS compiled_contract_id uuid REFERENCES flow_compilations(id) ON DELETE RESTRICT;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS compiled_contract_id uuid REFERENCES flow_compilations(id) ON DELETE RESTRICT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS compiled_contract_digest text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS result_classification text CHECK(result_classification IS NULL OR result_classification IN ('application_pass','application_failure','calibration_required','infrastructure_failure','environment_failure','policy_refusal','cancelled','legacy_authoring_attempt'));
ALTER TABLE runs ADD COLUMN IF NOT EXISTS reliability_eligible boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS runs_unresolved_candidate_compilation_idx ON runs(mission_id,objective_id,compiled_contract_id)
  WHERE compiled_contract_id IS NOT NULL AND reliability_eligible AND state IN ('queued','preparing','running','finalizing','failed','timed_out','infrastructure_error');

UPDATE runs r SET result_classification='legacy_authoring_attempt', reliability_eligible=false
WHERE r.result_classification IS NULL AND r.outcome_classification IN ('inconclusive_plan','readiness_timeout')
  AND NOT EXISTS (SELECT 1 FROM accepted_evidence e WHERE e.run_id=r.id AND e.invalidated_at IS NULL AND e.superseded_at IS NULL);

CREATE INDEX IF NOT EXISTS flow_drafts_project_updated_idx ON flow_drafts(project_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS probe_sessions_draft_created_idx ON probe_sessions(draft_id,created_at DESC);
CREATE INDEX IF NOT EXISTS flow_compilations_draft_created_idx ON flow_compilations(draft_id,created_at DESC);
CREATE INDEX IF NOT EXISTS authentication_contracts_project_idx ON authentication_contracts(project_id,environment_id,updated_at DESC);
