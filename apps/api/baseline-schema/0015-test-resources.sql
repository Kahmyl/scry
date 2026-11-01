-- Mission-owned external testing resources. Provider credentials and usable
-- access values use the existing Veil cipher. Do not retain raw message copies.
CREATE TABLE test_resources (
  id uuid PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES missions(id),
  kind text NOT NULL CHECK (kind IN ('mailbox','webhook')),
  name text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','closing','closed')),
  idempotency_key text NOT NULL,
  requested_lifetime integer NOT NULL,
  address text,
  private_data jsonb NOT NULL,
  lease_until timestamptz,
  lease_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE(mission_id,idempotency_key)
);
CREATE INDEX test_resources_mission ON test_resources(mission_id,created_at);
CREATE TABLE test_resource_events (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES test_resources(id),
  provider_event_id text NOT NULL,
  received_at timestamptz NOT NULL,
  title text NOT NULL,
  safe_content jsonb NOT NULL,
  protected_refs jsonb NOT NULL DEFAULT '[]',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(resource_id,provider_event_id)
);
CREATE INDEX test_resource_events_order ON test_resource_events(resource_id,recorded_at,id);
CREATE TABLE test_provider_limits (
  provider text PRIMARY KEY,
  next_request_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz NOT NULL DEFAULT now()
);
-- Down migration is deliberately absent: deployment rollback must retain
-- received evidence and provider cleanup state.
