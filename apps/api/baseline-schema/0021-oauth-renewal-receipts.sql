-- One encrypted retry receipt per grant. No bearer credential is stored in plaintext.
CREATE TABLE oauth_renewal_receipts (
  grant_hash text PRIMARY KEY REFERENCES oauth_connections(grant_hash) ON DELETE CASCADE,
  predecessor_hash text NOT NULL,
  successor_hash text NOT NULL,
  request_digest text NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  authentication_tag bytea NOT NULL,
  value_digest text NOT NULL,
  key_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at <= created_at + interval '10 seconds')
);
CREATE INDEX oauth_renewal_receipts_expiry ON oauth_renewal_receipts(expires_at);
CREATE TABLE oauth_connection_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('renewed','retry_recovered','replay_refused','disconnected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX oauth_connection_events_recent ON oauth_connection_events(connection_id,created_at DESC,id DESC);
ALTER TABLE oauth_renewal_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_connection_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON oauth_renewal_receipts,oauth_connection_events FROM PUBLIC;
