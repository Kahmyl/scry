-- M6: narrow, durable qualification authorization. This is not a general campaign platform.
CREATE TABLE IF NOT EXISTS qualification_campaign_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  mission_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  agent_session_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose='system_correctness'),
  target_origin text NOT NULL,
  application_identity text NOT NULL CHECK (length(application_identity) BETWEEN 1 AND 200),
  qualification_mode text NOT NULL CHECK (qualification_mode='local_test'),
  owner_user_id uuid NOT NULL,
  release_identity text NOT NULL CHECK (release_identity ~ '^[a-f0-9]{64}$'),
  schema_identity text NOT NULL CHECK (schema_identity ~ '^[a-f0-9]{64}$'),
  max_runs integer NOT NULL CHECK (max_runs=1),
  max_business_mutation_dispatches integer NOT NULL CHECK (max_business_mutation_dispatches=1),
  runs_consumed integer NOT NULL DEFAULT 0 CHECK (runs_consumed BETWEEN 0 AND max_runs),
  business_mutation_dispatches_consumed integer NOT NULL DEFAULT 0
    CHECK (business_mutation_dispatches_consumed BETWEEN 0 AND max_business_mutation_dispatches),
  disposition text NOT NULL DEFAULT 'authorized'
    CHECK (disposition IN ('authorized','succeeded','failed','inconclusive','expired','revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  FOREIGN KEY (mission_id,project_id) REFERENCES missions(id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (objective_id,mission_id) REFERENCES mission_objectives(id,mission_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_session_id,mission_id) REFERENCES agent_sessions(id,mission_id) ON DELETE RESTRICT
);

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS qualification_campaign_authorization_id uuid
    REFERENCES qualification_campaign_authorizations(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS qualification_campaign_single_run_idx
  ON runs(qualification_campaign_authorization_id)
  WHERE qualification_campaign_authorization_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_qualification_campaign_run_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  campaign qualification_campaign_authorizations%ROWTYPE;
BEGIN
  IF NEW.qualification_campaign_authorization_id IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM qualification_campaign_authorizations qualification
       WHERE qualification.project_id=NEW.project_id
         AND qualification.environment_id=NEW.environment_id
         AND qualification.mission_id=NEW.mission_id
         AND qualification.objective_id=NEW.objective_id
         AND qualification.agent_session_id=NEW.agent_session_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE='23514',
        MESSAGE='QUALIFICATION_CAMPAIGN_AUTHORIZATION_REQUIRED';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO campaign
    FROM qualification_campaign_authorizations
   WHERE id=NEW.qualification_campaign_authorization_id;
  IF NOT FOUND
     OR campaign.project_id<>NEW.project_id
     OR campaign.environment_id<>NEW.environment_id
     OR campaign.mission_id<>NEW.mission_id
     OR campaign.objective_id<>NEW.objective_id
     OR campaign.agent_session_id<>NEW.agent_session_id THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='QUALIFICATION_CAMPAIGN_SCOPE_MISMATCH';
  END IF;
  IF campaign.runs_consumed<>1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='QUALIFICATION_RUN_CAPABILITY_NOT_CONSUMED';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS qualification_campaign_run_binding ON runs;
CREATE TRIGGER qualification_campaign_run_binding
  BEFORE INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION enforce_qualification_campaign_run_binding();

CREATE TABLE IF NOT EXISTS qualification_campaign_mutation_consumptions (
  campaign_authorization_id uuid NOT NULL
    REFERENCES qualification_campaign_authorizations(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  operation_id text NOT NULL,
  mutation_identity text NOT NULL,
  mutation_outcome text NOT NULL DEFAULT 'unknown'
    CHECK (mutation_outcome IN ('unknown','applied','not_applied')),
  consumed_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (campaign_authorization_id,operation_id),
  UNIQUE (campaign_authorization_id,mutation_identity)
);

CREATE INDEX IF NOT EXISTS qualification_campaign_scope_idx
  ON qualification_campaign_authorizations(project_id,environment_id,mission_id,disposition,expires_at);

COMMENT ON TABLE qualification_campaign_authorizations IS
  'Single-Run/single-business-mutation local qualification authority. Historical work is never implicitly authorized.';
COMMENT ON TABLE qualification_campaign_mutation_consumptions IS
  'Last-pre-dispatch capability consumption; not a second business mutation truth journal.';
COMMENT ON FUNCTION enforce_qualification_campaign_run_binding() IS
  'Qualification-only database backstop: all Run writers must bind and durably consume an exact campaign.';
