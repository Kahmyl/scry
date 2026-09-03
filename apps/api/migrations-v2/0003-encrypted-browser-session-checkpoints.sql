ALTER TABLE browser_owner_generations
  ADD COLUMN runtime_capability_version text NOT NULL
  CHECK (runtime_capability_version='browser-runtime-v2.3');

CREATE TABLE browser_session_checkpoints (
  session_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  project_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  checkpoint_revision bigint NOT NULL CHECK (checkpoint_revision > 0),
  owner_generation bigint NOT NULL CHECK (owner_generation > 0),
  resume_origin text NOT NULL CHECK (resume_origin ~ '^https?://[^/]+$'),
  resume_url_digest text NOT NULL CHECK (resume_url_digest ~ '^[a-f0-9]{64}$'),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  authentication_tag bytea NOT NULL CHECK (octet_length(authentication_tag)=16),
  plaintext_digest text NOT NULL CHECK (plaintext_digest ~ '^[a-f0-9]{64}$'),
  key_version text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 2 AND 2097152),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id,run_id,project_id,mission_id)
    REFERENCES browser_execution_sessions(id,run_id,project_id,mission_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id,owner_generation)
    REFERENCES browser_owner_generations(session_id,generation) ON DELETE RESTRICT
);

CREATE INDEX browser_session_checkpoints_scope_idx
  ON browser_session_checkpoints(project_id,mission_id,run_id);
