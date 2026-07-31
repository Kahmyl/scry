CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  base_origin text NOT NULL,
  policy jsonb NOT NULL,
  secret_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE test_specifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE specification_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  specification_id uuid NOT NULL REFERENCES test_specifications(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (specification_id, version)
);

CREATE TABLE plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  specification_version_id uuid NOT NULL REFERENCES specification_versions(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  protocol_version text NOT NULL,
  plan jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (specification_version_id, version)
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft','queued','preparing','running','finalizing','passed','failed','cancelled','timed_out','infrastructure_error')),
  plan_snapshot jsonb NOT NULL,
  environment_snapshot jsonb NOT NULL,
  policy_snapshot jsonb NOT NULL,
  execution_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  state text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, attempt_number)
);

CREATE TABLE run_events (
  id bigserial PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, sequence)
);

CREATE TABLE assertion_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  step_id text NOT NULL,
  assertion_index integer NOT NULL,
  assertion_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('passed','failed','unevaluated')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, step_id, assertion_index)
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  step_id text,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','available','missing','failed','expired')),
  content_type text NOT NULL,
  storage_key text,
  size_bytes bigint,
  checksum_sha256 text,
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX runs_project_created_idx ON runs(project_id, created_at DESC);
CREATE INDEX attempts_run_idx ON attempts(run_id, attempt_number);
CREATE INDEX events_attempt_sequence_idx ON run_events(attempt_id, sequence);
CREATE INDEX artifacts_attempt_idx ON artifacts(attempt_id);
