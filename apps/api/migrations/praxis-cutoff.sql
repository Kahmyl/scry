ALTER TABLE worker_heartbeats
  ADD COLUMN IF NOT EXISTS praxis_contract_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS praxis_runtime_version text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS praxis_scoring_policy_version integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS worker_heartbeats_praxis_compatibility_idx
  ON worker_heartbeats(release_id, schema_fingerprint, praxis_contract_version, praxis_runtime_version, praxis_scoring_policy_version, heartbeat_at);
