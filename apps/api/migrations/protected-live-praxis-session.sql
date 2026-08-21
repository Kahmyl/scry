ALTER TABLE adaptive_sessions
  ADD COLUMN IF NOT EXISTS protection text NOT NULL DEFAULT 'ordinary'
  CHECK (protection IN ('ordinary','protected'));

ALTER TABLE mission_authorizations
  ADD COLUMN IF NOT EXISTS praxis_session_id uuid REFERENCES adaptive_sessions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS mission_authorizations_praxis_session_idx
  ON mission_authorizations(praxis_session_id)
  WHERE praxis_session_id IS NOT NULL;
