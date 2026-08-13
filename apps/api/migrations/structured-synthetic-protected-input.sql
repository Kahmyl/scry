UPDATE environments
SET policy=jsonb_set(
  policy,
  '{protectedSyntheticInputs,generators}',
  COALESCE(policy#>'{protectedSyntheticInputs,generators}','[]'::jsonb) ||
    '[{"contract":"nested_client_order_json","version":1,"purposes":["test_order_qualification"],"resourceScopes":[{"resourceKind":"order","operation":"create"}]}]'::jsonb,
  true
)
WHERE id='9a581bb0-2276-4888-9ddb-07b2485cddc3'::uuid
  AND project_id='6b3b5011-0f41-430c-a8a2-d4abfd9ff3f1'::uuid
  AND NOT COALESCE(policy#>'{protectedSyntheticInputs,generators}','[]'::jsonb) @>
    '[{"contract":"nested_client_order_json","version":1}]'::jsonb;
