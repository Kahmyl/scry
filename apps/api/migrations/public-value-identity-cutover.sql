DROP INDEX generated_public_values_project_reference_unique;
ALTER TABLE generated_public_values ADD COLUMN source_run_id uuid REFERENCES runs(id) ON DELETE CASCADE;

UPDATE generated_public_values value
   SET source_run_id = COALESCE(
     value.run_id,
     (SELECT transaction.run_id
        FROM protected_transactions transaction
        JOIN runs run ON run.id = transaction.run_id
       WHERE run.project_id = value.project_id
         AND transaction.operation_id = value.operation_id
       ORDER BY abs(extract(epoch FROM (transaction.created_at - value.created_at)))
       LIMIT 1)
   );

ALTER TABLE generated_public_values ALTER COLUMN source_run_id SET NOT NULL;
CREATE UNIQUE INDEX generated_public_values_transaction_reference_unique
  ON generated_public_values(source_run_id, operation_id, reference);
