-- Additive and inactive by default. Historical sessions are never reinterpreted.
ALTER TABLE browser_execution_sessions ADD COLUMN runtime_adapter text NOT NULL DEFAULT 'legacy'
  CHECK (runtime_adapter IN ('legacy','playwright_mcp'));
ALTER TABLE browser_commands DROP CONSTRAINT browser_commands_kind_check;
ALTER TABLE browser_commands ADD CONSTRAINT browser_commands_kind_check CHECK
  (kind IN ('navigate','observe','fill','click','press','capture_dom','commit','publish_capture',
    'discard_capture','determine','close','close_for_failure','browser_tool'));
-- The selected adapter is immutable, including after configuration rollback.
CREATE FUNCTION preserve_browser_adapter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.runtime_adapter <> OLD.runtime_adapter THEN
    RAISE EXCEPTION 'browser adapter is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER browser_adapter_immutable BEFORE UPDATE ON browser_execution_sessions
  FOR EACH ROW EXECUTE FUNCTION preserve_browser_adapter();
