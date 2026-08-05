ALTER TABLE flow_compilations
  ADD COLUMN IF NOT EXISTS compiled_plan jsonb;

UPDATE flow_compilations c
SET compiled_plan = d.plan
FROM flow_drafts d
WHERE d.id = c.draft_id
  AND c.compiled_plan IS NULL;

ALTER TABLE flow_compilations
  ALTER COLUMN compiled_plan SET NOT NULL;