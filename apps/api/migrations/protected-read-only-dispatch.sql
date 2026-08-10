ALTER TABLE protected_operations
  ADD COLUMN IF NOT EXISTS dispatch_semantics text NOT NULL DEFAULT 'mutation';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='protected_operations_dispatch_semantics_check'
  ) THEN
    ALTER TABLE protected_operations
      ADD CONSTRAINT protected_operations_dispatch_semantics_check
      CHECK(dispatch_semantics IN ('mutation','read_only'));
  END IF;
END $$;
