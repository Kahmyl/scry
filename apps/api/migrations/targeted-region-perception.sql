DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='authoring_runtime_commands_type_check'
      AND conrelid='authoring_runtime_commands'::regclass
  ) THEN
    ALTER TABLE authoring_runtime_commands
      DROP CONSTRAINT authoring_runtime_commands_type_check;
  END IF;

  ALTER TABLE authoring_runtime_commands
    ADD CONSTRAINT authoring_runtime_commands_type_check
    CHECK (type IN (
      'observe_document',
      'inspect_region',
      'interact',
      'advance_turn',
      'suspend',
      'resume',
      'cancel'
    ));
END $$;
