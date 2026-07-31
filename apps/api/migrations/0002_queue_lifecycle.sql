ALTER TABLE runs
  ADD COLUMN queued_at timestamptz,
  ADD COLUMN cancellation_requested_at timestamptz;

ALTER TABLE attempts
  ADD COLUMN claim_token uuid,
  ADD COLUMN worker_id text,
  ADD COLUMN heartbeat_at timestamptz;

CREATE UNIQUE INDEX attempts_claim_token_idx
  ON attempts(claim_token)
  WHERE claim_token IS NOT NULL;

CREATE INDEX attempts_heartbeat_idx
  ON attempts(heartbeat_at)
  WHERE state IN ('preparing', 'running', 'finalizing');
