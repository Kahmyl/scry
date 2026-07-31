ALTER TABLE runs
  ADD COLUMN rerun_of_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolved_by_run_id uuid REFERENCES runs(id) ON DELETE SET NULL;

WITH resolutions AS (
  SELECT DISTINCT ON (failed.id)
         failed.id AS failed_id,
         passed.id AS passed_id,
         passed.created_at AS passed_at
  FROM runs failed
  JOIN runs passed
    ON passed.project_id = failed.project_id
   AND passed.plan_version_id = failed.plan_version_id
   AND passed.environment_id = failed.environment_id
   AND passed.execution_snapshot = failed.execution_snapshot
   AND passed.state = 'passed'
   AND passed.created_at > failed.created_at
  WHERE failed.state IN ('failed', 'timed_out', 'infrastructure_error')
  ORDER BY failed.id, passed.created_at
)
UPDATE runs failed
SET resolved_at = resolutions.passed_at,
    resolved_by_run_id = resolutions.passed_id
FROM resolutions
WHERE failed.id = resolutions.failed_id;

CREATE INDEX runs_rerun_of_idx
  ON runs(rerun_of_run_id)
  WHERE rerun_of_run_id IS NOT NULL;

CREATE INDEX runs_unresolved_attention_idx
  ON runs(project_id, created_at DESC)
  WHERE state IN ('failed', 'timed_out', 'infrastructure_error')
    AND resolved_at IS NULL;
