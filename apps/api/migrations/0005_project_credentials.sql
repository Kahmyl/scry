CREATE TABLE project_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  initialization_vector bytea NOT NULL,
  authentication_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX project_credentials_active_name_idx
  ON project_credentials(project_id, name)
  WHERE deleted_at IS NULL;
