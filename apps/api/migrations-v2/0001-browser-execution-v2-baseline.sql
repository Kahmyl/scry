CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE schema_baseline (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  schema_fingerprint text NOT NULL CHECK (schema_fingerprint ~ '^[a-f0-9]{64}$'),
  runtime_capability_version text NOT NULL CHECK (length(runtime_capability_version) BETWEEN 1 AND 100),
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

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,user_id)
);

CREATE TABLE mcp_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  token_prefix text NOT NULL,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX mcp_access_tokens_workspace_v2_idx ON mcp_access_tokens(workspace_id,created_at DESC);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,name),
  UNIQUE (id,workspace_id)
);

CREATE TABLE missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  original_instruction text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'planning'
    CHECK (state IN ('planning','running','blocked','awaiting_user','completed','failed','cancelled')),
  current_objective_id uuid,
  final_report_id uuid,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (id,project_id),
  UNIQUE (project_id,idempotency_key),
  CHECK ((state IN ('completed','failed','cancelled')) = (completed_at IS NOT NULL))
);

CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL,
  project_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('codex','claude','scry_agent','human')),
  model text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  instruction_snapshot text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','completed','interrupted','failed')),
  idempotency_key text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  FOREIGN KEY (mission_id,project_id) REFERENCES missions(id,project_id) ON DELETE CASCADE,
  UNIQUE (mission_id,idempotency_key),
  UNIQUE (id,mission_id,project_id),
  CHECK ((state='active') = (ended_at IS NULL))
);

CREATE TABLE mission_objectives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','running','passed','failed','blocked','skipped')),
  completion_criteria jsonb NOT NULL,
  objective_order integer NOT NULL CHECK (objective_order >= 0),
  idempotency_key text NOT NULL,
  conclusion text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mission_id,project_id) REFERENCES missions(id,project_id) ON DELETE CASCADE,
  UNIQUE (mission_id,objective_order),
  UNIQUE (mission_id,idempotency_key),
  UNIQUE (id,mission_id,project_id)
);

ALTER TABLE missions
  ADD CONSTRAINT missions_current_objective_v2_fk
  FOREIGN KEY (current_objective_id,id,project_id)
  REFERENCES mission_objectives(id,mission_id,project_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  base_origin text NOT NULL CHECK (base_origin ~ '^https?://[^/]+$'),
  allowed_service_origins jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_service_origins)='array'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,name),
  UNIQUE (id,project_id)
);

CREATE TABLE flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  created_by_agent_session_id uuid NOT NULL,
  name text NOT NULL,
  purpose text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','superseded','abandoned')),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mission_id,project_id) REFERENCES missions(id,project_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_agent_session_id,mission_id,project_id)
    REFERENCES agent_sessions(id,mission_id,project_id) ON DELETE RESTRICT,
  UNIQUE (mission_id,idempotency_key),
  UNIQUE (id,mission_id,project_id)
);

CREATE TABLE flow_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('draft','active','superseded')),
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_agent_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  FOREIGN KEY (flow_id,mission_id,project_id) REFERENCES flows(id,mission_id,project_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_agent_session_id,mission_id,project_id)
    REFERENCES agent_sessions(id,mission_id,project_id) ON DELETE RESTRICT,
  UNIQUE (flow_id,revision),
  UNIQUE (id,flow_id,mission_id,project_id),
  CHECK ((state='active') = (activated_at IS NOT NULL))
);

CREATE UNIQUE INDEX flow_revisions_one_active_v2_idx ON flow_revisions(flow_id) WHERE state='active';

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  agent_session_id uuid NOT NULL,
  flow_id uuid NOT NULL,
  flow_revision_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  execution_model text NOT NULL DEFAULT 'agent_browser_v2' CHECK (execution_model='agent_browser_v2'),
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft','queued','starting','running','unknown','finalizing','passed','failed','cancelled','infrastructure_error')),
  outcome_classification text
    CHECK (outcome_classification IN ('passed','application_failure','environment_failure','blocked','cancelled','unknown')),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY (mission_id,project_id) REFERENCES missions(id,project_id) ON DELETE CASCADE,
  FOREIGN KEY (objective_id,mission_id,project_id)
    REFERENCES mission_objectives(id,mission_id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_session_id,mission_id,project_id)
    REFERENCES agent_sessions(id,mission_id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (flow_revision_id,flow_id,mission_id,project_id)
    REFERENCES flow_revisions(id,flow_id,mission_id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (environment_id,project_id) REFERENCES environments(id,project_id) ON DELETE RESTRICT,
  UNIQUE (mission_id,idempotency_key),
  UNIQUE (id,project_id,mission_id),
  CHECK ((state IN ('passed','failed','cancelled','infrastructure_error')) = (completed_at IS NOT NULL)),
  CHECK ((state IN ('passed','failed','cancelled','infrastructure_error')) = (outcome_classification IS NOT NULL))
);

CREATE TABLE browser_execution_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  project_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  agent_session_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'starting'
    CHECK (state IN ('starting','active','unknown','finalizing','completed','failed','cancelled')),
  active_owner_generation bigint NOT NULL DEFAULT 0 CHECK (active_owner_generation >= 0),
  current_document_epoch bigint NOT NULL DEFAULT 0 CHECK (current_document_epoch >= 0),
  authentication_commit_limit integer NOT NULL CHECK (authentication_commit_limit >= 0),
  authentication_commits_used integer NOT NULL DEFAULT 0 CHECK (authentication_commits_used >= 0),
  business_commit_limit integer NOT NULL CHECK (business_commit_limit >= 0),
  business_commits_used integer NOT NULL DEFAULT 0 CHECK (business_commits_used >= 0),
  allowed_first_party_origins jsonb NOT NULL CHECK (jsonb_typeof(allowed_first_party_origins)='array'),
  allowed_service_origins jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_service_origins)='array'),
  runtime_capability_version text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  FOREIGN KEY (run_id,project_id,mission_id) REFERENCES runs(id,project_id,mission_id) ON DELETE CASCADE,
  FOREIGN KEY (objective_id,mission_id,project_id)
    REFERENCES mission_objectives(id,mission_id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (environment_id,project_id) REFERENCES environments(id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_session_id,mission_id,project_id)
    REFERENCES agent_sessions(id,mission_id,project_id) ON DELETE RESTRICT,
  UNIQUE (run_id),
  UNIQUE (run_id,idempotency_key),
  UNIQUE (id,run_id,project_id,mission_id),
  CHECK (authentication_commits_used <= authentication_commit_limit),
  CHECK (business_commits_used <= business_commit_limit),
  CHECK ((state IN ('completed','failed','cancelled')) = (terminal_at IS NOT NULL))
);

CREATE TABLE browser_execution_outbox (
  session_id uuid PRIMARY KEY REFERENCES browser_execution_sessions(id) ON DELETE CASCADE,
  runtime_capability_version text NOT NULL,
  published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE browser_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES browser_execution_sessions(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  command_ordinal bigint NOT NULL CHECK (command_ordinal > 0),
  idempotency_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('navigate','observe','fill','click','press','capture_dom','commit','publish_capture','discard_capture','determine','close','close_for_failure')),
  safe_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  protected_input_ciphertext bytea,
  protected_input_nonce bytea CHECK (protected_input_nonce IS NULL OR octet_length(protected_input_nonce)=12),
  protected_input_authentication_tag bytea CHECK (protected_input_authentication_tag IS NULL OR octet_length(protected_input_authentication_tag)=16),
  protected_input_digest text CHECK (protected_input_digest IS NULL OR protected_input_digest ~ '^[a-f0-9]{64}$'),
  protected_input_key_version text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','completed','failed')),
  claim_token uuid,
  claim_lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  safe_result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (session_id,command_ordinal),
  UNIQUE (session_id,idempotency_key),
  CHECK ((state IN ('completed','failed')) = (completed_at IS NOT NULL)),
  CHECK (state <> 'completed' OR safe_result IS NOT NULL),
  CHECK (state <> 'failed' OR error_code IS NOT NULL)
  ,CHECK ((state='running') = (claim_lease_expires_at IS NOT NULL))
  ,CHECK ((state='running') = (claim_token IS NOT NULL))
  ,CHECK ((protected_input_ciphertext IS NULL) = (protected_input_nonce IS NULL))
  ,CHECK ((protected_input_ciphertext IS NULL) = (protected_input_authentication_tag IS NULL))
  ,CHECK ((protected_input_ciphertext IS NULL) = (protected_input_digest IS NULL))
  ,CHECK ((protected_input_ciphertext IS NULL) = (protected_input_key_version IS NULL))
);

CREATE TABLE browser_command_outbox (
  command_id uuid PRIMARY KEY REFERENCES browser_commands(id) ON DELETE CASCADE,
  published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE browser_owner_generations (
  session_id uuid NOT NULL REFERENCES browser_execution_sessions(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation > 0),
  worker_id text NOT NULL,
  lease_token uuid NOT NULL UNIQUE,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  state text NOT NULL CHECK (state IN ('active','replaced','released','lost')),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  terminal_at timestamptz,
  replacement_reason text,
  PRIMARY KEY (session_id,generation),
  CHECK ((state='active') = (terminal_at IS NULL))
);

CREATE UNIQUE INDEX browser_owner_one_active_v2_idx
  ON browser_owner_generations(session_id) WHERE state='active';

CREATE TABLE browser_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES browser_execution_sessions(id) ON DELETE CASCADE,
  action_ordinal bigint NOT NULL CHECK (action_ordinal > 0),
  owner_generation bigint NOT NULL,
  document_epoch bigint NOT NULL CHECK (document_epoch >= 0),
  tool text NOT NULL,
  sanitized_arguments jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_classification text NOT NULL CHECK (result_classification IN ('succeeded','failed','blocked','owner_lost')),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  safe_failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id,owner_generation)
    REFERENCES browser_owner_generations(session_id,generation) ON DELETE RESTRICT,
  UNIQUE (session_id,action_ordinal)
);

CREATE TABLE browser_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  run_id uuid NOT NULL,
  project_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  effect_ordinal bigint NOT NULL CHECK (effect_ordinal > 0),
  idempotency_key text NOT NULL,
  effect_class text NOT NULL CHECK (effect_class IN ('authentication','business')),
  owner_generation bigint NOT NULL,
  document_epoch bigint NOT NULL CHECK (document_epoch >= 0),
  expected_origin text NOT NULL CHECK (expected_origin ~ '^https?://[^/]+$'),
  target_digest text NOT NULL CHECK (target_digest ~ '^[a-f0-9]{64}$'),
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  intent_summary text NOT NULL,
  admission_state text NOT NULL CHECK (admission_state IN ('admitted','rejected')),
  dispatch_state text NOT NULL DEFAULT 'not_started'
    CHECK (dispatch_state IN ('not_started','started','acknowledged','unknown')),
  capture_state text NOT NULL DEFAULT 'not_started'
    CHECK (capture_state IN ('not_started','durable','unavailable','expired','corrupt')),
  publication_state text NOT NULL DEFAULT 'not_started'
    CHECK (publication_state IN ('not_started','published','discarded','failed')),
  mutation_outcome text NOT NULL DEFAULT 'pending'
    CHECK (mutation_outcome IN ('pending','applied','not_applied','unknown')),
  determination_source text,
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  provider_request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  safe_reconciliation_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  dispatch_started_at timestamptz,
  response_observed_at timestamptz,
  terminal_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id,run_id,project_id,mission_id)
    REFERENCES browser_execution_sessions(id,run_id,project_id,mission_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id,owner_generation)
    REFERENCES browser_owner_generations(session_id,generation) ON DELETE RESTRICT,
  UNIQUE (session_id,effect_ordinal),
  UNIQUE (session_id,idempotency_key),
  UNIQUE (id,session_id),
  UNIQUE (id,project_id,mission_id,run_id),
  CHECK (publication_state <> 'published' OR capture_state='durable'),
  CHECK (capture_state <> 'durable' OR dispatch_state='acknowledged'),
  CHECK (mutation_outcome <> 'applied' OR dispatch_state='acknowledged'),
  CHECK (mutation_outcome <> 'unknown' OR dispatch_state <> 'not_started'),
  CHECK ((mutation_outcome IN ('applied','not_applied','unknown')) = (terminal_at IS NOT NULL)),
  CHECK ((mutation_outcome IN ('applied','not_applied','unknown')) = (determination_source IS NOT NULL)),
  CHECK ((dispatch_state='not_started') = (dispatch_started_at IS NULL)),
  CHECK ((dispatch_state IN ('acknowledged')) = (response_observed_at IS NOT NULL))
);

CREATE TABLE browser_effect_events (
  effect_id uuid NOT NULL,
  session_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  type text NOT NULL CHECK (type IN (
    'admitted','dispatch_started','response_observed','capture_durable','publication_failed',
    'published','discarded','applied','not_applied','unknown','reconciled'
  )),
  safe_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (effect_id,session_id) REFERENCES browser_effects(id,session_id) ON DELETE CASCADE,
  PRIMARY KEY (effect_id,sequence)
);

CREATE TABLE browser_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effect_id uuid NOT NULL,
  session_id uuid NOT NULL,
  evidence_version integer NOT NULL CHECK (evidence_version > 0),
  object_key text NOT NULL UNIQUE,
  ciphertext_digest text NOT NULL CHECK (ciphertext_digest ~ '^[a-f0-9]{64}$'),
  authenticated_metadata jsonb NOT NULL,
  content_class text NOT NULL CHECK (content_class IN ('http_json','http_text','dom_region')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 524288),
  state text NOT NULL CHECK (state IN ('durable','published','expired','corrupt','deleted')),
  structural_index jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(structural_index)='array'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  FOREIGN KEY (effect_id,session_id) REFERENCES browser_effects(id,session_id) ON DELETE CASCADE,
  UNIQUE (id,effect_id,session_id),
  CHECK ((state='deleted') = (deleted_at IS NOT NULL)),
  CHECK (expires_at > captured_at)
);

CREATE TABLE protected_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mission_id uuid REFERENCES missions(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE CASCADE,
  source_effect_id uuid,
  source_kind text NOT NULL CHECK (source_kind IN ('user_input','generated')),
  display_name text NOT NULL,
  external_reference text NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  authentication_tag bytea NOT NULL CHECK (octet_length(authentication_tag)=16),
  value_digest text NOT NULL CHECK (value_digest ~ '^[a-f0-9]{64}$'),
  key_version text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','expired','compromised','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  deleted_at timestamptz,
  idempotency_key text,
  UNIQUE (project_id,external_reference),
  UNIQUE (project_id,idempotency_key),
  UNIQUE (id,project_id),
  FOREIGN KEY (mission_id,project_id) REFERENCES missions(id,project_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id,project_id,mission_id) REFERENCES runs(id,project_id,mission_id) ON DELETE CASCADE,
  FOREIGN KEY (source_effect_id,project_id,mission_id,run_id)
    REFERENCES browser_effects(id,project_id,mission_id,run_id) ON DELETE RESTRICT,
  CHECK ((source_kind='generated') = (source_effect_id IS NOT NULL)),
  CHECK (source_kind <> 'generated' OR (mission_id IS NOT NULL AND run_id IS NOT NULL)),
  CHECK ((state='deleted') = (deleted_at IS NOT NULL))
);

CREATE TABLE browser_session_protected_inputs (
  session_id uuid NOT NULL REFERENCES browser_execution_sessions(id) ON DELETE CASCADE,
  protected_value_id uuid NOT NULL REFERENCES protected_values(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id,protected_value_id)
);

CREATE TABLE browser_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id uuid NOT NULL,
  effect_id uuid NOT NULL,
  session_id uuid NOT NULL,
  selection_digest text NOT NULL CHECK (selection_digest ~ '^[a-f0-9]{64}$'),
  output_count integer NOT NULL CHECK (output_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (capture_id,effect_id,session_id)
    REFERENCES browser_captures(id,effect_id,session_id) ON DELETE RESTRICT,
  UNIQUE (capture_id),
  UNIQUE (id,effect_id)
);

CREATE TABLE browser_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL,
  effect_id uuid NOT NULL,
  project_id uuid NOT NULL,
  canonical_name text NOT NULL CHECK (canonical_name ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$'),
  classification text NOT NULL CHECK (classification IN ('public','protected')),
  public_value jsonb,
  protected_value_id uuid,
  identity_role text,
  safe_correlation_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (publication_id,effect_id) REFERENCES browser_publications(id,effect_id) ON DELETE CASCADE,
  FOREIGN KEY (protected_value_id,project_id) REFERENCES protected_values(id,project_id) ON DELETE RESTRICT,
  UNIQUE (effect_id,canonical_name),
  CHECK ((classification='public') = (public_value IS NOT NULL)),
  CHECK ((classification='protected') = (protected_value_id IS NOT NULL)),
  CHECK (NOT (public_value IS NOT NULL AND protected_value_id IS NOT NULL))
);

CREATE TABLE browser_evidence_streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL UNIQUE REFERENCES browser_execution_sessions(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','complete','incomplete','corrupt','expired')),
  chain_head text CHECK (chain_head ~ '^[a-f0-9]{64}$'),
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  total_bytes bigint NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  replay_artifact_key text,
  video_artifact_key text,
  retention_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((state='complete') = (completed_at IS NOT NULL)),
  CHECK (state <> 'complete' OR (chain_head IS NOT NULL AND chunk_count > 0))
);

CREATE TABLE browser_evidence_chunks (
  stream_id uuid NOT NULL REFERENCES browser_evidence_streams(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  object_key text NOT NULL UNIQUE,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  previous_digest text NOT NULL,
  first_sequence bigint NOT NULL CHECK (first_sequence >= 0),
  last_sequence bigint NOT NULL CHECK (last_sequence >= first_sequence),
  stored_bytes integer NOT NULL CHECK (stored_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id,chunk_index),
  UNIQUE (stream_id,digest),
  CHECK ((chunk_index=0 AND previous_digest='GENESIS') OR (chunk_index>0 AND previous_digest ~ '^[a-f0-9]{64}$'))
);

CREATE TABLE mission_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL UNIQUE REFERENCES missions(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('draft','final')),
  summary text NOT NULL,
  safe_report jsonb NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  CHECK ((state='final') = (finalized_at IS NOT NULL))
);

ALTER TABLE missions
  ADD CONSTRAINT missions_final_report_v2_fk
  FOREIGN KEY (final_report_id) REFERENCES mission_reports(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('recording','video','screenshot','trace','report_attachment')),
  object_key text NOT NULL UNIQUE,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX browser_effects_unresolved_v2_idx
  ON browser_effects(session_id,effect_class,effect_ordinal)
  WHERE mutation_outcome IN ('pending','unknown');

CREATE INDEX browser_execution_outbox_pending_v2_idx
  ON browser_execution_outbox(created_at) WHERE published_at IS NULL;

CREATE INDEX browser_command_outbox_pending_v2_idx
  ON browser_command_outbox(created_at) WHERE published_at IS NULL;

CREATE INDEX browser_captures_expiry_v2_idx
  ON browser_captures(expires_at)
  WHERE state='durable';

CREATE INDEX protected_values_active_v2_idx
  ON protected_values(project_id,display_name)
  WHERE state='active';
