ALTER TABLE browser_owner_generations
  DROP CONSTRAINT browser_owner_generations_runtime_capability_id_check,
  ADD CONSTRAINT browser_owner_generations_runtime_capability_id_check
    CHECK (runtime_capability_id='browser-execution');

ALTER TABLE browser_execution_sessions
  ADD COLUMN interpretation_state text NOT NULL DEFAULT 'not_started'
    CHECK (interpretation_state IN ('not_started','complete','failed')),
  ADD COLUMN continuation_state text NOT NULL DEFAULT 'not_started'
    CHECK (continuation_state IN ('not_started','acknowledged','cancelled')),
  ADD COLUMN recovery_fence bigint NOT NULL DEFAULT 0 CHECK (recovery_fence >= 0),
  ADD COLUMN recovery_lease_owner text,
  ADD COLUMN recovery_lease_expires_at timestamptz,
  ADD CONSTRAINT browser_execution_sessions_runtime_capability
    CHECK (runtime_capability_id='browser-execution'),
  ADD CONSTRAINT browser_execution_sessions_recovery_lease_pair
    CHECK ((recovery_lease_owner IS NULL) = (recovery_lease_expires_at IS NULL));

ALTER TABLE browser_captures
  ADD COLUMN encrypted_payload bytea,
  ADD COLUMN encrypted_payload_digest text
    CHECK (encrypted_payload_digest IS NULL OR encrypted_payload_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT browser_captures_durable_payload
    CHECK (
      (state='durable' AND encrypted_payload IS NOT NULL AND encrypted_payload_digest IS NOT NULL)
      OR
      (state<>'durable' AND encrypted_payload IS NULL AND encrypted_payload_digest IS NULL)
    );

UPDATE schema_baseline
SET runtime_capability_id='browser-execution';
