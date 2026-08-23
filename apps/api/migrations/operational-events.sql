-- Durable, privacy-safe operational telemetry. Chronicle remains product provenance authority.
CREATE TABLE IF NOT EXISTS operational_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL CHECK(schema_version = 1),
  occurred_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  event_name text NOT NULL CHECK(length(event_name) BETWEEN 1 AND 120),
  component text NOT NULL CHECK(component IN ('api','mcp','worker','praxis','runtime')),
  classification text NOT NULL CHECK(classification IN (
    'validation','policy_refusal','stale_authority','application_provider',
    'infrastructure','persistence','reconciliation_unknown'
  )),
  reason_code text NOT NULL CHECK(reason_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  outcome text NOT NULL CHECK(outcome IN ('failed','refused','inconclusive','reconciliation_required')),
  critical boolean NOT NULL CHECK(critical),
  release_id text NOT NULL CHECK(length(release_id) BETWEEN 1 AND 200),
  schema_fingerprint text NOT NULL CHECK(length(schema_fingerprint) BETWEEN 1 AND 200),
  duration_ms double precision CHECK(duration_ms IS NULL OR duration_ms >= 0),
  transition_from text,
  transition_to text,
  project_id text,
  workspace_id text,
  mission_id text,
  objective_id text,
  agent_session_id text,
  mcp_session_id text,
  run_id text,
  attempt_id text,
  praxis_session_id text,
  operation_id text,
  protected_operation_id text,
  correlation_id text,
  browser_context_id text,
  document_authority_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK((transition_from IS NULL) = (transition_to IS NULL)),
  CHECK(details::text !~* '(bearer[[:space:]]+[^"[:space:]]+|eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)')
);

CREATE INDEX IF NOT EXISTS operational_events_occurred_idx
  ON operational_events(occurred_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS operational_events_name_component_idx
  ON operational_events(event_name,component,occurred_at DESC);
CREATE INDEX IF NOT EXISTS operational_events_classification_reason_idx
  ON operational_events(classification,reason_code,occurred_at DESC);
CREATE INDEX IF NOT EXISTS operational_events_correlation_idx
  ON operational_events(correlation_id,occurred_at DESC) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS operational_events_mission_run_idx
  ON operational_events(mission_id,run_id,occurred_at DESC)
  WHERE mission_id IS NOT NULL OR run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS operational_events_praxis_protected_idx
  ON operational_events(praxis_session_id,protected_operation_id,occurred_at DESC)
  WHERE praxis_session_id IS NOT NULL OR protected_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS operational_events_project_idx
  ON operational_events(project_id,occurred_at DESC) WHERE project_id IS NOT NULL;
