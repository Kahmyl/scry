-- General factual resource-effect reconciliation, including applied effects whose
-- protected generated output could not be recovered. Such operations remain fenced
-- until an independently authorized cleanup is positively proven.
ALTER TABLE adaptive_operation_reconciliations
  DROP CONSTRAINT IF EXISTS adaptive_operation_reconciliations_result_check;
ALTER TABLE adaptive_operation_reconciliations
  ADD CONSTRAINT adaptive_operation_reconciliations_result_check CHECK(result IN (
    'proven_applied','proven_applied_output_unrecovered','proven_not_applied','still_unknown'
  ));

CREATE OR REPLACE VIEW unresolved_adaptive_unknown_operations AS
SELECT operation.*
  FROM adaptive_operations operation
 WHERE operation.mutation_outcome='unknown'
   AND NOT EXISTS (
     SELECT 1 FROM adaptive_operation_reconciliations reconciliation
      WHERE reconciliation.session_id=operation.session_id
        AND reconciliation.operation_id=operation.operation_id
        AND reconciliation.state='completed'
        AND reconciliation.result IN ('proven_applied','proven_not_applied')
   );
