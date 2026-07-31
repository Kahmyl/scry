CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_user_id uuid NOT NULL UNIQUE,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

INSERT INTO workspaces(name, slug)
VALUES ('Legacy workspace', 'legacy')
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE projects ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE projects SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'legacy')
WHERE workspace_id IS NULL;
ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL;

CREATE INDEX projects_workspace_created_idx ON projects(workspace_id, created_at DESC);
CREATE INDEX workspace_memberships_user_idx ON workspace_memberships(user_id, workspace_id);
