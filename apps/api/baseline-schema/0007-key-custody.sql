ALTER TABLE browser_owner_generations
  DROP CONSTRAINT browser_owner_generations_runtime_capability_id_check,
  ADD CONSTRAINT browser_owner_generations_runtime_capability_id_check
    CHECK (runtime_capability_id='browser-execution');

ALTER TABLE browser_execution_sessions
  DROP CONSTRAINT browser_execution_sessions_runtime_capability,
  ADD COLUMN protection_key_id text NOT NULL
    CHECK (protection_key_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  ADD CONSTRAINT browser_execution_sessions_runtime_capability
    CHECK (runtime_capability_id='browser-execution');

CREATE TABLE identity_import_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('rehearsal','permanent')),
  source_database_digest text NOT NULL CHECK (source_database_digest ~ '^[a-f0-9]{64}$'),
  identity_digest text NOT NULL UNIQUE CHECK (identity_digest ~ '^[a-f0-9]{64}$'),
  user_count integer NOT NULL CHECK (user_count >= 0),
  workspace_count integer NOT NULL CHECK (workspace_count >= 0),
  membership_count integer NOT NULL CHECK (membership_count >= 0),
  project_count integer NOT NULL CHECK (project_count >= 0),
  imported_at timestamptz NOT NULL DEFAULT now()
);

UPDATE schema_baseline
SET runtime_capability_id='browser-execution';
