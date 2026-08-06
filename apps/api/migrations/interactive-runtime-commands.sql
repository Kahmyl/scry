CREATE TABLE IF NOT EXISTS authoring_runtime_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_session_id uuid NOT NULL
    REFERENCES probe_sessions(id)
    ON DELETE CASCADE,
  browser_lease_id uuid NOT NULL,
  type text NOT NULL
    CHECK (type IN ('observe_document')),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN (
      'pending',
      'claimed',
      'completed',
      'failed',
      'cancelled'
    )),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_by_agent_session_id uuid NOT NULL
    REFERENCES agent_sessions(id)
    ON DELETE RESTRICT,
  claimed_by_runtime_owner_id text,
  claim_token uuid UNIQUE,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (browser_lease_id, probe_session_id)
    REFERENCES authoring_browser_leases(id, probe_session_id)
    ON DELETE RESTRICT,
  UNIQUE (probe_session_id, idempotency_key),
  UNIQUE (id, probe_session_id),
  CHECK (
    (
      claimed_by_runtime_owner_id IS NULL
      AND claim_token IS NULL
      AND claimed_at IS NULL
    )
    OR
    (
      claimed_by_runtime_owner_id IS NOT NULL
      AND claim_token IS NOT NULL
      AND claimed_at IS NOT NULL
    )
  ),
  CHECK (
    state <> 'pending'
    OR (
      claimed_by_runtime_owner_id IS NULL
      AND claim_token IS NULL
      AND claimed_at IS NULL
    )
  ),
  CHECK (
    state <> 'claimed'
    OR (
      claimed_by_runtime_owner_id IS NOT NULL
      AND claim_token IS NOT NULL
      AND claimed_at IS NOT NULL
    )
  ),
  CHECK (
    (state IN ('completed', 'failed', 'cancelled')) =
    (completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS authoring_runtime_commands_pending_idx
  ON authoring_runtime_commands(browser_lease_id, created_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS authoring_runtime_commands_claimed_idx
  ON authoring_runtime_commands(claimed_by_runtime_owner_id, claimed_at)
  WHERE state = 'claimed';

CREATE TABLE IF NOT EXISTS authoring_runtime_command_results (
  command_id uuid PRIMARY KEY
    REFERENCES authoring_runtime_commands(id)
    ON DELETE CASCADE,
  probe_session_id uuid NOT NULL,
  outcome text NOT NULL
    CHECK (outcome IN ('completed', 'failed', 'cancelled')),
  safe_result jsonb,
  safe_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (command_id, probe_session_id)
    REFERENCES authoring_runtime_commands(id, probe_session_id)
    ON DELETE CASCADE,
  CHECK (
    (outcome = 'completed' AND safe_result IS NOT NULL AND safe_error IS NULL)
    OR
    (outcome = 'failed' AND safe_result IS NULL AND safe_error IS NOT NULL)
    OR
    (outcome = 'cancelled' AND safe_result IS NULL)
  )
);
