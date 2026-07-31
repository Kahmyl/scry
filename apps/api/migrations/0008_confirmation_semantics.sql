-- A repeated readiness timeout establishes reproducibility of the timeout only.
-- It does not validate the semantic expectation and must never be promoted to a
-- confirmed tested-product failure.
UPDATE runs original
SET outcome_classification = 'readiness_timeout',
    updated_at = now()
FROM runs confirmation
WHERE original.confirmation_run_id = confirmation.id
  AND original.outcome_classification = 'confirmed_product_failure'
  AND confirmation.outcome_classification = 'readiness_timeout';
