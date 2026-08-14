ALTER TABLE flow_drafts
  ADD COLUMN IF NOT EXISTS predecessor_run_id uuid REFERENCES runs(id) ON DELETE RESTRICT;

ALTER TABLE adaptive_sessions
  ADD COLUMN IF NOT EXISTS restored_successor_checkpoint_id uuid;

CREATE TABLE IF NOT EXISTS run_successor_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  flow_revision_id uuid NOT NULL REFERENCES flow_revisions(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK(state IN ('establishing','available','restoring','verified','failed','destroyed')),
  ciphertext bytea,
  initialization_vector bytea,
  authentication_tag bytea,
  binding_fingerprint text NOT NULL CHECK(binding_fingerprint ~ '^[a-f0-9]{64}$'),
  restoration_commitment text NOT NULL CHECK(restoration_commitment ~ '^[a-f0-9]{64}$'),
  semantic_commitment text NOT NULL CHECK(semantic_commitment ~ '^[a-f0-9]{64}$'),
  claimed_by_authoring_session_id uuid REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  restore_owner_id text,
  restore_fencing_token bigint,
  restoration_attempts integer NOT NULL DEFAULT 0 CHECK(restoration_attempts BETWEEN 0 AND 10),
  expires_at timestamptz NOT NULL,
  reason_code text,
  established_at timestamptz NOT NULL DEFAULT now(),
  sealed_at timestamptz,
  restored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(run_id,mission_id,objective_id) REFERENCES runs(id,mission_id,objective_id) ON DELETE CASCADE,
  CHECK ((state IN ('establishing','available','restoring','verified') AND ciphertext IS NOT NULL
      AND initialization_vector IS NOT NULL AND authentication_tag IS NOT NULL)
    OR (state IN ('failed','destroyed') AND ciphertext IS NULL
      AND initialization_vector IS NULL AND authentication_tag IS NULL)),
  CHECK ((state='restoring' AND restore_owner_id IS NOT NULL AND restore_fencing_token IS NOT NULL)
    OR state<>'restoring')
);

CREATE INDEX IF NOT EXISTS run_successor_checkpoints_mission_idx
  ON run_successor_checkpoints(mission_id,created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS flow_drafts_active_predecessor_idx
  ON flow_drafts(predecessor_run_id)
  WHERE predecessor_run_id IS NOT NULL AND state IN ('editing','probing','compiled');

DO $$ BEGIN
  ALTER TABLE adaptive_sessions
    ADD CONSTRAINT adaptive_sessions_restored_successor_checkpoint_fk
    FOREIGN KEY(restored_successor_checkpoint_id)
    REFERENCES run_successor_checkpoints(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
