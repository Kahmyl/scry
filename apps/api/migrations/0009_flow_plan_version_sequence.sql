-- Plan version numbers are presented as the executable version of a Flow, so
-- they must increase across all specification revisions belonging to that Flow.
WITH numbered AS (
  SELECT pv.id,
         ROW_NUMBER() OVER (
           PARTITION BY sv.specification_id
           ORDER BY sv.version, pv.created_at, pv.id
         )::integer AS flow_version
  FROM plan_versions pv
  JOIN specification_versions sv ON sv.id = pv.specification_version_id
)
UPDATE plan_versions pv
SET version = numbered.flow_version
FROM numbered
WHERE pv.id = numbered.id
  AND pv.version IS DISTINCT FROM numbered.flow_version;
