CREATE TABLE mission_cleanup_decisions (
  id uuid PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK(kind IN ('resource','credential')),
  item_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('retain','close','revoke')),
  reason text NOT NULL CHECK(reason IN ('testing_finished','user_selected_retention','shared_preexisting','needed_for_recovery')),
  idempotency_key text NOT NULL,
  input_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(mission_id,idempotency_key)
);
CREATE INDEX mission_cleanup_inventory ON mission_cleanup_decisions(mission_id,kind,item_id,created_at DESC);
ALTER TABLE mission_cleanup_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mission_cleanup_decisions FROM PUBLIC;

CREATE TABLE media_playback_grants (
  id uuid PRIMARY KEY,
  secret_hash text NOT NULL CHECK(secret_hash ~ '^[a-f0-9]{64}$'),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  media_index integer NOT NULL CHECK(media_index>=0),
  artifact_digest text NOT NULL CHECK(artifact_digest ~ '^[a-f0-9]{64}$'),
  user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK(source_kind IN ('user','oauth','mcp','service')),
  source_id uuid,
  source_hash text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((source_kind='service' AND user_id IS NULL AND workspace_id IS NULL) OR (source_kind<>'service' AND user_id IS NOT NULL AND workspace_id IS NOT NULL)),
  CHECK(source_kind NOT IN ('oauth','mcp') OR source_id IS NOT NULL),
  CHECK(source_kind<>'service' OR (source_hash IS NOT NULL AND source_hash ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX media_playback_expiry ON media_playback_grants(expires_at);
CREATE INDEX media_playback_principal ON media_playback_grants(user_id) WHERE revoked_at IS NULL;
ALTER TABLE media_playback_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON media_playback_grants FROM PUBLIC;
