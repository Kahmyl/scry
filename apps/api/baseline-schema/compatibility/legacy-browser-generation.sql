-- Compatibility-only bridge for the historical browser rollout schema proven
-- in the isolated migration test. The deployment controller captures a fenced
-- PostgreSQL dump before this transaction; failure rolls back automatically,
-- and post-commit deployment failure restores that dump before traffic returns.

ALTER TABLE browser_execution_sessions
  DROP CONSTRAINT IF EXISTS browser_execution_sessions_runtime_capability_v27;
ALTER TABLE browser_owner_generations
  DROP CONSTRAINT IF EXISTS browser_owner_generations_runtime_capability_version_check;
ALTER TABLE schema_baseline
  DROP CONSTRAINT IF EXISTS schema_baseline_runtime_capability_version_check;

ALTER TABLE schema_baseline
  RENAME COLUMN runtime_capability_version TO runtime_capability_id;
ALTER TABLE browser_execution_sessions
  RENAME COLUMN runtime_capability_version TO runtime_capability_id;
ALTER TABLE browser_execution_outbox
  RENAME COLUMN runtime_capability_version TO runtime_capability_id;
ALTER TABLE browser_owner_generations
  RENAME COLUMN runtime_capability_version TO runtime_capability_id;
ALTER TABLE browser_execution_sessions
  RENAME COLUMN protection_key_version TO protection_key_id;
ALTER TABLE browser_commands
  RENAME COLUMN protected_input_key_version TO protected_input_key_id;
ALTER TABLE browser_captures
  RENAME COLUMN evidence_version TO evidence_format;
ALTER TABLE protected_values
  RENAME COLUMN key_version TO key_id;
ALTER TABLE browser_session_checkpoints
  RENAME COLUMN key_version TO key_id;

UPDATE schema_baseline SET runtime_capability_id='browser-execution';
UPDATE browser_execution_sessions SET runtime_capability_id='browser-execution';
UPDATE browser_execution_outbox SET runtime_capability_id='browser-execution';
UPDATE browser_owner_generations SET runtime_capability_id='browser-execution';

ALTER TABLE schema_baseline
  DROP COLUMN schema_version,
  DROP COLUMN schema_fingerprint,
  DROP COLUMN catalog_fingerprint,
  ADD CONSTRAINT schema_baseline_runtime_capability
    CHECK (runtime_capability_id='browser-execution');

INSERT INTO schema_baseline(singleton,runtime_capability_id)
SELECT true,'browser-execution'
WHERE NOT EXISTS (SELECT 1 FROM schema_baseline WHERE singleton=true);
ALTER TABLE browser_execution_sessions
  ADD CONSTRAINT browser_execution_sessions_runtime_capability
    CHECK (runtime_capability_id='browser-execution');
ALTER TABLE browser_owner_generations
  ADD CONSTRAINT browser_owner_generations_runtime_capability
    CHECK (runtime_capability_id='browser-execution');
