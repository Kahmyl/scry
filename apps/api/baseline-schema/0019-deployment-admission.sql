-- Shared by old and new session/command writers, not just a controller precheck.
CREATE TABLE browser_deployment_admission (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  held boolean NOT NULL DEFAULT false,
  owner text,
  CHECK(held=(owner IS NOT NULL))
);
INSERT INTO browser_deployment_admission(singleton) VALUES(true);
ALTER TABLE browser_deployment_admission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON browser_deployment_admission FROM PUBLIC;

CREATE FUNCTION browser_require_work_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1935897209,1);
  IF (SELECT held FROM browser_deployment_admission WHERE singleton) THEN
    RAISE EXCEPTION 'SCRY_BROWSER_DEPLOYMENT_GATED' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER browser_session_deployment_admission BEFORE INSERT ON browser_execution_sessions
FOR EACH ROW EXECUTE FUNCTION browser_require_work_admission();
CREATE TRIGGER browser_command_deployment_admission BEFORE INSERT ON browser_commands
FOR EACH ROW EXECUTE FUNCTION browser_require_work_admission();

CREATE FUNCTION browser_try_deployment(controller text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE current_gate browser_deployment_admission; active_work integer;
BEGIN
  IF controller IS NULL OR length(controller) NOT BETWEEN 1 AND 200 THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(1935897209,1);
  SELECT * INTO current_gate FROM browser_deployment_admission WHERE singleton FOR UPDATE;
  IF current_gate.held AND current_gate.owner<>controller THEN RETURN NULL; END IF;
  SELECT count(*)::int INTO active_work FROM (
    SELECT id FROM browser_execution_sessions WHERE state NOT IN ('completed','failed','cancelled')
    UNION SELECT session_id FROM browser_commands WHERE state IN ('queued','running')
    UNION SELECT o.session_id FROM browser_owner_generations o JOIN browser_execution_sessions s ON s.id=o.session_id
      WHERE o.generation=s.active_owner_generation AND o.state<>'released'
  ) inventory;
  IF active_work>0 THEN RETURN active_work; END IF;
  UPDATE browser_deployment_admission SET held=true,owner=controller WHERE singleton;
  RETURN 0;
END $$;
REVOKE ALL ON FUNCTION browser_try_deployment(text) FROM PUBLIC;
