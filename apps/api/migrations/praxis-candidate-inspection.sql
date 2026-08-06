CREATE TABLE IF NOT EXISTS praxis_candidate_requests (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (
    status IN ('queued', 'claimed', 'running', 'completed', 'failed')
  ),
  payload jsonb NOT NULL,
  result jsonb,
  worker_id text,
  claim_token text,
  claimed_at timestamptz,
  completed_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS praxis_candidate_requests_status_idx
  ON praxis_candidate_requests(status);

CREATE INDEX IF NOT EXISTS praxis_candidate_requests_worker_idx
  ON praxis_candidate_requests(worker_id);
