ALTER TABLE mission_authorizations
  ADD COLUMN IF NOT EXISTS operation_id text;

COMMENT ON COLUMN mission_authorizations.operation_id IS
  'Exact protected operation scope. This is factual authorization scope, not semantic target or progression authority.';
