ALTER TABLE flow_compilations
  ADD COLUMN IF NOT EXISTS adaptive_session_id uuid
  REFERENCES adaptive_sessions(id) ON DELETE RESTRICT;

ALTER TABLE adaptive_sessions
  ADD COLUMN IF NOT EXISTS qualified_flow_draft_version integer
  CHECK (qualified_flow_draft_version IS NULL OR qualified_flow_draft_version > 0);

ALTER TABLE run_successor_checkpoints
  DROP CONSTRAINT IF EXISTS run_successor_checkpoints_check;

ALTER TABLE run_successor_checkpoints
  DROP CONSTRAINT IF EXISTS run_successor_checkpoints_payload_lifecycle_check;

UPDATE run_successor_checkpoints
SET ciphertext=NULL,
    initialization_vector=NULL,
    authentication_tag=NULL,
    updated_at=now()
WHERE state='verified';

ALTER TABLE run_successor_checkpoints
  ADD CONSTRAINT run_successor_checkpoints_payload_lifecycle_check
  CHECK (
    (state IN ('establishing','available','restoring') AND ciphertext IS NOT NULL
      AND initialization_vector IS NOT NULL AND authentication_tag IS NOT NULL)
    OR (state IN ('verified','failed','destroyed') AND ciphertext IS NULL
      AND initialization_vector IS NULL AND authentication_tag IS NULL)
  );

ALTER TABLE flow_compilations
  DROP CONSTRAINT IF EXISTS flow_compilations_single_qualification_source_check;

ALTER TABLE flow_compilations
  ADD CONSTRAINT flow_compilations_single_qualification_source_check
  CHECK (probe_session_id IS NULL OR adaptive_session_id IS NULL);

CREATE INDEX IF NOT EXISTS flow_compilations_adaptive_session_idx
  ON flow_compilations(adaptive_session_id)
  WHERE adaptive_session_id IS NOT NULL;
