-- Permit an authorization-free prepared reservation to settle truthfully when its
-- owning Praxis session closes before dispatch. This only widens terminal,
-- proven-not-applied authoring states; dispatched/recovery states still require
-- the exact authorization bound by the prepared-operation lifecycle.

DO $$
DECLARE owner_constraint record;
BEGIN
  FOR owner_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='protected_operations'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%owner_kind%authorization_id%'
  LOOP
    EXECUTE format('ALTER TABLE protected_operations DROP CONSTRAINT %I', owner_constraint.conname);
  END LOOP;
END $$;

ALTER TABLE protected_operations
  ADD CONSTRAINT protected_operations_owner_shape_check CHECK(
    (owner_kind='authoring_session' AND authoring_session_id IS NOT NULL AND run_id IS NULL
      AND flow_draft_id IS NOT NULL
      AND (
        state IN ('reserved','failed_not_applied','abandoned')
        OR authorization_id IS NOT NULL
      ))
    OR (owner_kind='run' AND run_id IS NOT NULL AND authoring_session_id IS NULL
      AND flow_revision_id IS NOT NULL)
  );
