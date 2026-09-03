ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS blocker_code text,
  ADD COLUMN IF NOT EXISTS terminal_outcome text;

UPDATE agent_sessions session
   SET project_id=mission.project_id,
       workspace_id=project.workspace_id
  FROM missions mission
  JOIN projects project ON project.id=mission.project_id
 WHERE session.mission_id=mission.id
   AND (session.project_id IS NULL OR session.workspace_id IS NULL);

ALTER TABLE agent_sessions ALTER COLUMN mission_id DROP NOT NULL;

ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_status_check;
ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_status_check
  CHECK (status IN ('active','blocked','completed','interrupted','failed'));

ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_optional_mission_owner_check
  CHECK (mission_id IS NOT NULL OR external_run_id IS NOT NULL),
  ADD CONSTRAINT agent_sessions_blocker_code_check
  CHECK (blocker_code IS NULL OR blocker_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  ADD CONSTRAINT agent_sessions_terminal_outcome_check
  CHECK (terminal_outcome IS NULL OR terminal_outcome IN (
    'objective_completed','blocked_user_authority','blocked_system','limit_exceeded',
    'provider_failure','cancelled','model_stopped_without_completion'
  ));

DROP INDEX IF EXISTS agent_sessions_external_run_idx;
CREATE UNIQUE INDEX agent_sessions_external_run_unique
  ON agent_sessions(external_run_id)
  WHERE external_run_id IS NOT NULL;

CREATE INDEX agent_sessions_project_external_run_idx
  ON agent_sessions(project_id,external_run_id)
  WHERE project_id IS NOT NULL AND external_run_id IS NOT NULL;
