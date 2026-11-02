-- Application-owned OAuth state. Never expose provider payloads through a Data API.
CREATE TABLE oauth_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  client_id text NOT NULL,
  client_name text NOT NULL,
  grant_hash text NOT NULL UNIQUE,
  scope text NOT NULL CHECK (scope = 'scry:testing'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX oauth_connections_user ON oauth_connections(user_id, created_at DESC);
CREATE INDEX oauth_connections_workspace ON oauth_connections(workspace_id);
CREATE INDEX oauth_connections_client ON oauth_connections(client_id);

CREATE TABLE oauth_provider_records (
  model text NOT NULL,
  id_hash text NOT NULL,
  uid_hash text,
  grant_hash text,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  authentication_tag bytea NOT NULL,
  value_digest text NOT NULL,
  key_id text NOT NULL,
  consumed_at timestamptz,
  expires_at timestamptz,
  PRIMARY KEY (model, id_hash)
);
CREATE INDEX oauth_provider_uid ON oauth_provider_records(model, uid_hash) WHERE uid_hash IS NOT NULL;
CREATE INDEX oauth_provider_grant ON oauth_provider_records(grant_hash) WHERE grant_hash IS NOT NULL;
CREATE INDEX oauth_provider_expiry ON oauth_provider_records(expires_at) WHERE expires_at IS NOT NULL;
ALTER TABLE oauth_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_provider_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON oauth_connections, oauth_provider_records FROM PUBLIC;
