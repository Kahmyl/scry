CREATE OR REPLACE FUNCTION adaptive_operation_unknown_unresolved(
  input_session_id uuid,
  input_operation_id text
)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT
      operation.authoring_intent->'action'->>'kind' <> 'authenticate'
      AND NOT EXISTS (
        SELECT 1
          FROM adaptive_operation_reconciliations reconciliation
         WHERE reconciliation.session_id=operation.session_id
           AND reconciliation.operation_id=operation.operation_id
           AND reconciliation.state='completed'
           AND reconciliation.result IN ('proven_applied','proven_not_applied')
      )
      FROM adaptive_operations operation
     WHERE operation.session_id=input_session_id
       AND operation.operation_id=input_operation_id
  ),false)
$$;
