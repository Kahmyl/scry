CREATE TABLE mcp_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mcp_access_tokens_workspace_created_idx
  ON mcp_access_tokens(workspace_id, created_at DESC);

CREATE INDEX mcp_access_tokens_active_hash_idx
  ON mcp_access_tokens(token_hash)
  WHERE revoked_at IS NULL;
