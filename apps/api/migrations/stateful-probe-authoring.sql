ALTER TABLE probe_sessions
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'queued';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'probe_sessions_mode_check'
      AND conrelid = 'probe_sessions'::regclass
  ) THEN
    ALTER TABLE probe_sessions
      ADD CONSTRAINT probe_sessions_mode_check
      CHECK (mode IN ('queued', 'interactive'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS authoring_browser_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_session_id uuid NOT NULL REFERENCES probe_sessions(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'provisioning'
    CHECK (state IN (
      'provisioning',
      'active',
      'suspended',
      'releasing',
      'released',
      'expired',
      'crashed'
    )),
  lease_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  runtime_owner_id text,
  heartbeat_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  UNIQUE (id, probe_session_id),
  CHECK ((state = 'released') = (released_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS authoring_browser_leases_live_probe_idx
  ON authoring_browser_leases(probe_session_id)
  WHERE state IN ('provisioning', 'active', 'suspended', 'releasing');

CREATE TABLE IF NOT EXISTS probe_authoring_sessions (
  probe_session_id uuid PRIMARY KEY REFERENCES probe_sessions(id) ON DELETE CASCADE,
  browser_lease_id uuid UNIQUE,
  status text NOT NULL DEFAULT 'starting'
    CHECK (status IN (
      'starting',
      'active',
      'suspended',
      'completing',
      'completed',
      'cancelled',
      'crashed'
    )),
  active_page_id text,
  active_frame_id text,
  current_url text,
  document_epoch integer NOT NULL DEFAULT 0 CHECK (document_epoch >= 0),
  actions_used integer NOT NULL DEFAULT 0 CHECK (actions_used >= 0),
  action_budget integer NOT NULL CHECK (action_budget > 0),
  duration_budget_ms bigint NOT NULL CHECK (duration_budget_ms > 0),
  deadline_at timestamptz NOT NULL,
  veil_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  resume_pointer jsonb,
  last_observation_id uuid,
  pending_interaction jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (browser_lease_id, probe_session_id)
    REFERENCES authoring_browser_leases(id, probe_session_id)
    ON DELETE RESTRICT,
  CHECK (
    (status IN ('completed', 'cancelled', 'crashed')) =
    (completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS authoring_browser_leases_state_expiry_idx
  ON authoring_browser_leases(state, expires_at);

CREATE INDEX IF NOT EXISTS probe_authoring_sessions_status_deadline_idx
  ON probe_authoring_sessions(status, deadline_at);
