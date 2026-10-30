-- Additive facts only: historical commands are not rewritten. A recovered legacy
-- command receives its first deadline at its next claim, not at migration time.
ALTER TABLE browser_commands
  ADD COLUMN execution_deadline_at timestamptz,
  ADD COLUMN execution_budget_ms integer,
  ADD CONSTRAINT browser_commands_execution_deadline_valid CHECK (
    (execution_deadline_at IS NULL) = (execution_budget_ms IS NULL)
    AND (execution_deadline_at IS NULL OR
      (isfinite(execution_deadline_at) AND execution_budget_ms BETWEEN 1000 AND 900000))
  );

CREATE FUNCTION preserve_browser_command_deadline() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.execution_deadline_at IS NOT NULL AND
    (NEW.execution_deadline_at IS DISTINCT FROM OLD.execution_deadline_at OR
     NEW.execution_budget_ms IS DISTINCT FROM OLD.execution_budget_ms) THEN
    RAISE EXCEPTION 'command_deadline_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER browser_command_deadline_immutable
BEFORE UPDATE OF execution_deadline_at,execution_budget_ms ON browser_commands
FOR EACH ROW EXECUTE FUNCTION preserve_browser_command_deadline();
