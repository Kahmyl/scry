CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE schema_baseline (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_fingerprint text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_user_id uuid NOT NULL UNIQUE,
  email text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspaces(id, name, slug) VALUES ('00000000-0000-4000-8000-000000000001', 'Scry Service', 'scry-service');
CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE mcp_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name text NOT NULL, token_hash text NOT NULL UNIQUE, token_prefix text NOT NULL, last_used_at timestamptz,
  expires_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name text NOT NULL, description text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE TABLE missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL, original_instruction text NOT NULL,
  status text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','running','blocked','awaiting_user','completed','failed','cancelled')),
  current_objective_id uuid, resume_pointer jsonb, final_report_id uuid,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(id, project_id)
);
CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('codex','claude','scry_agent','human')), connection_id text,
  instruction_snapshot text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','interrupted','failed')),
  idempotency_key text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  UNIQUE(mission_id, idempotency_key), UNIQUE(id, mission_id)
);
CREATE TABLE mission_objectives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  title text NOT NULL, description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','passed','failed','blocked','skipped')),
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb, completion_criteria jsonb NOT NULL,
  conclusion text, objective_order integer NOT NULL CHECK (objective_order >= 0), latest_candidate_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(mission_id, objective_order), UNIQUE(id, mission_id)
);
CREATE TABLE mission_execution_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision>0), status text NOT NULL CHECK(status IN ('draft','active','paused','superseded','cancelled')),
  source_mission_revision integer NOT NULL, created_by_agent_session_id uuid NOT NULL, idempotency_key text NOT NULL DEFAULT gen_random_uuid()::text, created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz,
  FOREIGN KEY(created_by_agent_session_id,mission_id) REFERENCES agent_sessions(id,mission_id), UNIQUE(mission_id,revision), UNIQUE(mission_id,idempotency_key), UNIQUE(id,mission_id)
);
CREATE UNIQUE INDEX mission_execution_plan_active_idx ON mission_execution_plans(mission_id) WHERE status IN ('active','paused');
CREATE TABLE mission_objective_orchestration (
  mission_id uuid NOT NULL, objective_id uuid PRIMARY KEY, plan_id uuid NOT NULL REFERENCES mission_execution_plans(id) ON DELETE CASCADE,
  state text NOT NULL CHECK(state IN ('unscheduled','ready','queued','running','awaiting_evidence','passed','failed','blocked','awaiting_authorization','cancelled')),
  active_run_id uuid, blocker_code text, blocker_details jsonb NOT NULL DEFAULT '{}'::jsonb, lease_token uuid, lease_expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(objective_id,mission_id) REFERENCES mission_objectives(id,mission_id)
);
CREATE TABLE evidence_recommendations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mission_id uuid NOT NULL, objective_id uuid NOT NULL, plan_id uuid NOT NULL REFERENCES mission_execution_plans(id),
 revision integer NOT NULL, recommended_run_id uuid, score_components jsonb NOT NULL, exclusions jsonb NOT NULL, explanation text NOT NULL, evidence_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), superseded_at timestamptz, FOREIGN KEY(objective_id,mission_id) REFERENCES mission_objectives(id,mission_id), UNIQUE(objective_id,revision)
);
CREATE TABLE mission_report_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mission_id uuid NOT NULL REFERENCES missions(id), revision integer NOT NULL, source_mission_revision integer NOT NULL,
 evidence_digest text NOT NULL, snapshot jsonb NOT NULL, created_by_agent_session_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), superseded_at timestamptz,
 FOREIGN KEY(created_by_agent_session_id,mission_id) REFERENCES agent_sessions(id,mission_id), UNIQUE(mission_id,revision)
);
ALTER TABLE missions ADD CONSTRAINT missions_current_objective_fk FOREIGN KEY (current_objective_id, id)
  REFERENCES mission_objectives(id, mission_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE mission_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  objective_id uuid, agent_session_id uuid,
  type text NOT NULL, summary text NOT NULL, safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  technical boolean NOT NULL DEFAULT false, occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (objective_id, mission_id) REFERENCES mission_objectives(id, mission_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_session_id, mission_id) REFERENCES agent_sessions(id, mission_id) ON DELETE RESTRICT
);
CREATE TABLE activity_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  from_activity_id uuid NOT NULL REFERENCES mission_activities(id) ON DELETE CASCADE,
  to_activity_id uuid NOT NULL REFERENCES mission_activities(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('caused_by','diagnoses','replaces','depends_on','produced','verified_by','accepted_for')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(from_activity_id, to_activity_id, relation), CHECK(from_activity_id <> to_activity_id)
);
CREATE OR REPLACE FUNCTION reject_mission_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Mission history is append-only'; END $$;
CREATE TRIGGER mission_activities_immutable BEFORE UPDATE OR DELETE ON mission_activities
  FOR EACH ROW EXECUTE FUNCTION reject_mission_history_mutation();
CREATE TRIGGER activity_relations_immutable BEFORE UPDATE OR DELETE ON activity_relations
  FOR EACH ROW EXECUTE FUNCTION reject_mission_history_mutation();
CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL, base_origin text NOT NULL, policy jsonb NOT NULL, secret_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, name)
);
CREATE TABLE mission_authorizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),mission_id uuid NOT NULL,objective_id uuid NOT NULL,environment_id uuid NOT NULL REFERENCES environments(id),kind text NOT NULL CHECK(kind IN ('live_read','live_mutation','protected_mutation')),reason text NOT NULL,status text NOT NULL DEFAULT 'approved' CHECK(status IN ('approved','revoked')),granted_by_agent_session_id uuid NOT NULL,granted_by_user_id uuid,expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,
 FOREIGN KEY(objective_id,mission_id) REFERENCES mission_objectives(id,mission_id),FOREIGN KEY(granted_by_agent_session_id,mission_id) REFERENCES agent_sessions(id,mission_id)
);
CREATE TABLE project_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL, ciphertext bytea NOT NULL, initialization_vector bytea NOT NULL, authentication_tag bytea NOT NULL,
  security_status text NOT NULL DEFAULT 'active' CHECK (security_status IN ('active','compromised','revoked')),
  origin_mission_id uuid REFERENCES missions(id) ON DELETE SET NULL, origin_objective_id uuid REFERENCES mission_objectives(id) ON DELETE SET NULL,
  created_by_agent_session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);

CREATE TABLE flows (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL, description text NOT NULL DEFAULT '', latest_revision_id uuid NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('reusable','mission_local','internal')),
  purpose text NOT NULL CHECK (purpose IN ('primary','setup','acceptance','diagnostic','calibration','reconciliation','cleanup','verification')),
  origin_mission_id uuid REFERENCES missions(id) ON DELETE SET NULL, origin_objective_id uuid REFERENCES mission_objectives(id) ON DELETE SET NULL,
  created_by_agent_session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, name)
);
CREATE TABLE flow_revisions (
  id uuid PRIMARY KEY, flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  revision integer NOT NULL CHECK (revision > 0), content jsonb NOT NULL, plan jsonb NOT NULL,
  validation jsonb NOT NULL, created_by_agent_session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, revision), UNIQUE (id, flow_id)
);
CREATE TABLE semantic_target_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE, flow_revision_id uuid NOT NULL REFERENCES flow_revisions(id) ON DELETE CASCADE,
  origin text NOT NULL, intent_digest text NOT NULL CHECK(intent_digest ~ '^[a-f0-9]{64}$'), fingerprint jsonb NOT NULL,
  confidence numeric NOT NULL CHECK(confidence >= 0 AND confidence <= 1), confidence_margin numeric NOT NULL CHECK(confidence_margin >= 0 AND confidence_margin <= 1),
  drift text NOT NULL CHECK(drift IN ('unchanged','compatible','suspicious','incompatible')), success_count integer NOT NULL DEFAULT 1 CHECK(success_count > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,environment_id,flow_revision_id,origin,intent_digest)
);
CREATE TABLE grounding_diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL, step_id text NOT NULL, intent_digest text NOT NULL CHECK(intent_digest ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK(outcome IN ('resolved','rejected','effect_failed','drift_rejected')), failure_code text,
  candidate_count integer NOT NULL DEFAULT 0, eligible_count integer NOT NULL DEFAULT 0, confidence numeric NOT NULL DEFAULT 0,
  confidence_margin numeric NOT NULL DEFAULT 0, score_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  rejected_constraints jsonb NOT NULL DEFAULT '[]'::jsonb, selected_fingerprint jsonb, drift text NOT NULL CHECK(drift IN ('unchanged','compatible','suspicious','incompatible')),
  safe_actions jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE grounding_diagnostics
  ADD COLUMN resolution_source text NOT NULL DEFAULT 'unified' CHECK(resolution_source = 'unified'),
  ADD COLUMN visual_candidate_count integer NOT NULL DEFAULT 0 CHECK(visual_candidate_count >= 0),
  ADD COLUMN observation jsonb NOT NULL DEFAULT '{"status":"succeeded"}'::jsonb,
  ADD COLUMN evidence_families jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN correlation_groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN degraded_policy text,
  ADD COLUMN selected_adapter text CHECK(selected_adapter IS NULL OR selected_adapter IN ('native_fill','native_click','native_check','native_select','focus_keyboard','content_editable','application_adapter','canvas_coordinate'));
CREATE TABLE mission_execution_bindings (
  plan_id uuid NOT NULL REFERENCES mission_execution_plans(id) ON DELETE CASCADE, mission_id uuid NOT NULL, objective_id uuid NOT NULL,
  mode text NOT NULL CHECK(mode IN ('automatic','manual')), flow_revision_id uuid REFERENCES flow_revisions(id), environment_id uuid REFERENCES environments(id),
  execution_settings jsonb NOT NULL DEFAULT '{}'::jsonb, authorization_ids jsonb NOT NULL DEFAULT '[]'::jsonb, PRIMARY KEY(plan_id,objective_id),
  FOREIGN KEY(objective_id,mission_id) REFERENCES mission_objectives(id,mission_id),
  CHECK(mode='manual' OR (flow_revision_id IS NOT NULL AND environment_id IS NOT NULL))
);
ALTER TABLE flows ADD CONSTRAINT flows_latest_revision_fk FOREIGN KEY (latest_revision_id, id)
  REFERENCES flow_revisions(id, flow_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE OR REPLACE FUNCTION reject_flow_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM runs WHERE flow_revision_id = OLD.id) THEN
    RAISE EXCEPTION 'flow revisions are immutable while referenced';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER flow_revisions_immutable BEFORE UPDATE OR DELETE ON flow_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_flow_revision_mutation();
CREATE TABLE mission_flow_links (
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE, objective_id uuid NOT NULL,
  flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  visibility text NOT NULL CHECK (visibility IN ('reusable','mission_local','internal')),
  purpose text NOT NULL CHECK (purpose IN ('primary','setup','acceptance','diagnostic','calibration','reconciliation','cleanup','verification')),
  reason text NOT NULL, created_by_agent_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(mission_id, flow_id),
  FOREIGN KEY (objective_id, mission_id) REFERENCES mission_objectives(id, mission_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_agent_session_id, mission_id) REFERENCES agent_sessions(id, mission_id) ON DELETE RESTRICT
);

CREATE TABLE idempotency_records (
  scope text NOT NULL, key text NOT NULL, request_hash text NOT NULL, response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, PRIMARY KEY (scope, key)
);
CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  mission_id uuid NOT NULL, objective_id uuid NOT NULL, agent_session_id uuid NOT NULL,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  flow_revision_id uuid NOT NULL REFERENCES flow_revisions(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','preparing','running','finalizing','passed','failed','cancelled','timed_out','infrastructure_error')),
  phase text NOT NULL DEFAULT 'queued' CHECK (phase IN ('validating','queued','preparing','executing_action','waiting_readiness','evaluating_assertions','capturing_evidence','finalizing','completed')),
  outcome_classification text, plan_snapshot jsonb NOT NULL, environment_snapshot jsonb NOT NULL,
  policy_snapshot jsonb NOT NULL, execution_snapshot jsonb NOT NULL, idempotency_key text NOT NULL,
  cancellation_requested_at timestamptz, queued_at timestamptz, rerun_of_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, idempotency_key),
  FOREIGN KEY (mission_id, project_id) REFERENCES missions(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (objective_id, mission_id) REFERENCES mission_objectives(id, mission_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_session_id, mission_id) REFERENCES agent_sessions(id, mission_id) ON DELETE RESTRICT,
  UNIQUE(id, mission_id, objective_id)
);
ALTER TABLE grounding_diagnostics ADD CONSTRAINT grounding_diagnostics_run_fk FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE;
CREATE INDEX semantic_target_history_lookup_idx ON semantic_target_history(project_id,environment_id,origin,intent_digest,last_seen_at DESC);
CREATE INDEX grounding_diagnostics_run_idx ON grounding_diagnostics(run_id,created_at);
CREATE TABLE mission_run_links (
  run_id uuid PRIMARY KEY, mission_id uuid NOT NULL, objective_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('exploratory','diagnostic','calibration','candidate','accepted','superseded','invalidated')),
  reason text NOT NULL, classified_by_agent_session_id uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, mission_id, objective_id) REFERENCES runs(id, mission_id, objective_id) ON DELETE CASCADE,
  FOREIGN KEY (classified_by_agent_session_id, mission_id) REFERENCES agent_sessions(id, mission_id) ON DELETE RESTRICT
);
CREATE TABLE attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL, state text NOT NULL, worker_id text, claim_token uuid, heartbeat_at timestamptz,
  started_at timestamptz, completed_at timestamptz, error text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, attempt_number), UNIQUE (claim_token)
);
CREATE TABLE run_events (
  id bigserial PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  sequence integer NOT NULL, type text NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (attempt_id, sequence)
);
CREATE TABLE step_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  step_id text NOT NULL, ordinal integer NOT NULL, action_status text NOT NULL CHECK (action_status IN ('passed','failed','unevaluated')),
  action_error text, readiness jsonb, assertions_summary jsonb NOT NULL, evidence jsonb NOT NULL,
  started_at timestamptz, completed_at timestamptz, duration_ms integer, UNIQUE (attempt_id, step_id)
);
CREATE TABLE assertion_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  step_id text NOT NULL, assertion_index integer NOT NULL, assertion_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('passed','failed','unevaluated')), error text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (attempt_id, step_id, assertion_index)
);

CREATE TABLE privacy_intervals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  operation_id text NOT NULL, sequence integer NOT NULL, mode text NOT NULL CHECK (mode IN ('protected_element','protected_surface','protected_recording_gap')),
  started_at timestamptz NOT NULL, ended_at timestamptz, terminal_state text, safe_boundary_kind text, failure_code text,
  UNIQUE (attempt_id, sequence), UNIQUE (attempt_id, operation_id)
);
CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  step_id text, kind text NOT NULL,
  availability text NOT NULL CHECK (availability IN ('pending','available','incomplete','quarantined','destroyed','failed')),
  privacy_classification text NOT NULL CHECK (privacy_classification IN ('safe','sanitized','uncertain')),
  failure_provenance text CHECK (failure_provenance IN ('product','plan','policy','infrastructure','privacy')),
  reason_code text, content_type text NOT NULL, storage_key text, size_bytes bigint, checksum_sha256 text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, retention_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((availability = 'available' AND storage_key IS NOT NULL AND checksum_sha256 IS NOT NULL)
      OR (availability <> 'available' AND storage_key IS NULL)),
  CHECK (availability NOT IN ('quarantined','destroyed') OR privacy_classification = 'uncertain')
);
CREATE TABLE accepted_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mission_id uuid NOT NULL, objective_id uuid NOT NULL,
  run_id uuid NOT NULL, artifact_id uuid REFERENCES artifacts(id) ON DELETE RESTRICT,
  conclusion text NOT NULL, accepted_by_agent_session_id uuid NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz, invalidated_at timestamptz,
  FOREIGN KEY (run_id, mission_id, objective_id) REFERENCES runs(id, mission_id, objective_id) ON DELETE RESTRICT,
  FOREIGN KEY (objective_id, mission_id) REFERENCES mission_objectives(id, mission_id) ON DELETE CASCADE,
  FOREIGN KEY (accepted_by_agent_session_id, mission_id) REFERENCES agent_sessions(id, mission_id) ON DELETE RESTRICT,
  UNIQUE(objective_id, run_id, artifact_id)
);
CREATE UNIQUE INDEX accepted_evidence_run_unique ON accepted_evidence(objective_id, run_id) WHERE artifact_id IS NULL;
CREATE TABLE artifact_timeline_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  sequence integer NOT NULL, entry_type text NOT NULL CHECK (entry_type IN ('video_segment','trace_segment','protected_gap','unavailable_interval','quarantine_record','capture_epoch','checkpoint_boundary')),
  artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL, operation_id text, channel text,
  started_at timestamptz NOT NULL, ended_at timestamptz, reason_code text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (attempt_id, sequence)
);

\ir protected-capsule.sql
CREATE TABLE run_captured_secrets (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE, operation_id text NOT NULL, reference text NOT NULL,
  ciphertext bytea NOT NULL, initialization_vector bytea NOT NULL, authentication_tag bytea NOT NULL,
  security_status text NOT NULL DEFAULT 'active' CHECK (security_status IN ('active','compromised')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (run_id, operation_id), UNIQUE (run_id, reference)
);
CREATE TABLE generated_public_values (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE, run_id uuid REFERENCES runs(id) ON DELETE CASCADE,
  operation_id text NOT NULL, name text NOT NULL, reference text NOT NULL, scope text NOT NULL CHECK (scope IN ('run','project')),
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  objective_id uuid NOT NULL REFERENCES mission_objectives(id) ON DELETE RESTRICT,
  value text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'run' AND run_id IS NOT NULL) OR (scope = 'project' AND run_id IS NULL))
);
CREATE UNIQUE INDEX generated_public_values_transaction_reference_unique ON generated_public_values(source_run_id, operation_id, reference);
CREATE UNIQUE INDEX project_credentials_active_name_idx ON project_credentials(project_id, name) WHERE deleted_at IS NULL;

CREATE TABLE run_outbox (
  run_id uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, release_id text NOT NULL, schema_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, publish_attempts integer NOT NULL DEFAULT 0, last_error text
);
CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY, release_id text NOT NULL, schema_fingerprint text NOT NULL, heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE run_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  checkpoint_id text NOT NULL, state text NOT NULL CHECK (state IN ('establishing','available','restoring','verified','failed','destroyed')),
  ciphertext bytea, initialization_vector bytea, authentication_tag bytea,
  binding_fingerprint text NOT NULL, restoration_url text NOT NULL, continue_at_step_id text NOT NULL,
  restoration_attempts integer NOT NULL DEFAULT 0 CHECK (restoration_attempts BETWEEN 0 AND 1),
  expires_at timestamptz NOT NULL, reason_code text, established_at timestamptz, restored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, checkpoint_id),
  CHECK ((state IN ('available','restoring') AND ciphertext IS NOT NULL AND initialization_vector IS NOT NULL AND authentication_tag IS NOT NULL)
    OR (state NOT IN ('available','restoring') AND ciphertext IS NULL AND initialization_vector IS NULL AND authentication_tag IS NULL))
);
\ir calibration-foundation.sql
CREATE TABLE adapter_registrations (
  id text PRIMARY KEY, capability text NOT NULL CHECK (capability IN ('clipboard_extraction','network_extraction','safe_exit','credential_revocation')),
  release_id text NOT NULL, configuration_schema jsonb NOT NULL, permitted_origins jsonb NOT NULL,
  suppressed_channels jsonb NOT NULL, timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 100 AND 30000), enabled boolean NOT NULL DEFAULT true
);
INSERT INTO adapter_registrations(id, capability, release_id, configuration_schema, permitted_origins, suppressed_channels, timeout_ms) VALUES
  ('gauntlet.clipboard','clipboard_extraction','builtin','{"type":"object","additionalProperties":false}'::jsonb,'[]'::jsonb,'["video","trace","screenshot","dom","accessibility","console","page_error","network","report","event"]'::jsonb,2000),
  ('gauntlet.network','network_extraction','builtin','{"required":["origin","method","path","jsonPointer"]}'::jsonb,'[]'::jsonb,'["network","report","event","metadata"]'::jsonb,2000),
  ('gauntlet.safe-exit','safe_exit','builtin','{"required":["kind"]}'::jsonb,'[]'::jsonb,'["trace","screenshot","dom","accessibility","console","page_error","network"]'::jsonb,5000),
  ('gauntlet.revocation','credential_revocation','builtin','{"required":["endpoint"]}'::jsonb,'[]'::jsonb,'["network","report","event","metadata"]'::jsonb,5000);
CREATE TABLE credential_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE, credential_id uuid REFERENCES project_credentials(id) ON DELETE SET NULL,
  run_secret_id uuid REFERENCES run_captured_secrets(id) ON DELETE SET NULL, operation_id text NOT NULL,
  adapter_id text REFERENCES adapter_registrations(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('pending','revoked','failed','timed_out','manual_action_required')),
  reason_code text NOT NULL, safe_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
  CHECK ((credential_id IS NOT NULL)::int + (run_secret_id IS NOT NULL)::int <= 1)
);

CREATE TABLE mission_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0), status text NOT NULL DEFAULT 'published' CHECK(status IN ('published','superseded')),
  snapshot jsonb NOT NULL, published_by_agent_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), superseded_at timestamptz,
  FOREIGN KEY (published_by_agent_session_id, mission_id) REFERENCES agent_sessions(id, mission_id) ON DELETE RESTRICT,
  UNIQUE(mission_id, revision), UNIQUE(id, mission_id)
);
CREATE OR REPLACE FUNCTION protect_mission_report_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.mission_id<>OLD.mission_id OR NEW.revision<>OLD.revision OR NEW.snapshot<>OLD.snapshot
     OR NEW.published_by_agent_session_id<>OLD.published_by_agent_session_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Mission report snapshots are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_reports_snapshot_immutable BEFORE UPDATE OR DELETE ON mission_reports
  FOR EACH ROW EXECUTE FUNCTION protect_mission_report_snapshot();
ALTER TABLE missions ADD CONSTRAINT missions_final_report_fk FOREIGN KEY (final_report_id, id)
  REFERENCES mission_reports(id, mission_id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX flows_project_updated_idx ON flows(project_id, updated_at DESC);
CREATE INDEX missions_project_updated_idx ON missions(project_id, updated_at DESC);
CREATE INDEX mission_objectives_mission_order_idx ON mission_objectives(mission_id, objective_order);
CREATE INDEX mission_activities_mission_time_idx ON mission_activities(mission_id, occurred_at DESC);
CREATE INDEX mission_run_links_mission_role_idx ON mission_run_links(mission_id, role, updated_at DESC);
CREATE INDEX mission_reports_mission_revision_idx ON mission_reports(mission_id, revision DESC);
CREATE INDEX flow_revisions_flow_revision_idx ON flow_revisions(flow_id, revision DESC);
CREATE INDEX runs_project_created_idx ON runs(project_id, created_at DESC);
CREATE INDEX attempts_run_idx ON attempts(run_id, attempt_number);
CREATE INDEX run_events_attempt_sequence_idx ON run_events(attempt_id, sequence);
CREATE INDEX artifacts_attempt_idx ON artifacts(attempt_id);
CREATE INDEX artifact_timeline_attempt_sequence_idx ON artifact_timeline_entries(attempt_id, sequence);
CREATE INDEX worker_heartbeats_recent_idx ON worker_heartbeats(heartbeat_at DESC);
CREATE INDEX run_checkpoints_run_idx ON run_checkpoints(run_id, created_at);
CREATE INDEX credential_incidents_project_idx ON credential_incidents(project_id, created_at DESC);
\ir authoring-execution-cutover.sql
\ir praxis-reporting.sql
\ir praxis-cutoff.sql
\ir praxis-candidate-inspection.sql
\ir veil-observation-preferences.sql
\ir veil-artifact-retention.sql
\ir compiled-plan-cutover.sql
\ir stateful-probe-authoring.sql
\ir interactive-runtime-commands.sql
\ir interactive-runtime-lifecycle.sql
