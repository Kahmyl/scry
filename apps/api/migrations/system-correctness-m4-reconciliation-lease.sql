-- M4: bound observation-only reconciliation ownership without rewriting UNKNOWN history.
ALTER TABLE adaptive_operation_reconciliations
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS adaptive_operation_reconciliation_lease_idx
  ON adaptive_operation_reconciliations(lease_expires_at)
  WHERE state='observing';
