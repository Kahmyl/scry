-- M6 Q5: canonical application authority, scoped external capability, and one paid-attempt fuse.
CREATE TABLE IF NOT EXISTS qualification_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity text NOT NULL UNIQUE CHECK (identity ~ '^[a-z][a-z0-9._-]{2,199}$'),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  base_origin text NOT NULL,
  allowed_origins jsonb NOT NULL CHECK (
    jsonb_typeof(allowed_origins)='array' AND jsonb_array_length(allowed_origins) BETWEEN 1 AND 20
  ),
  credential_reference_ids jsonb NOT NULL CHECK (
    jsonb_typeof(credential_reference_ids)='array'
    AND jsonb_array_length(credential_reference_ids) BETWEEN 1 AND 20
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,environment_id),
  UNIQUE(id,project_id,environment_id)
);

CREATE OR REPLACE FUNCTION protect_qualification_application_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity<>OLD.identity OR NEW.project_id<>OLD.project_id
     OR NEW.environment_id<>OLD.environment_id OR NEW.base_origin<>OLD.base_origin
     OR NEW.allowed_origins<>OLD.allowed_origins
     OR NEW.credential_reference_ids<>OLD.credential_reference_ids
     OR NEW.created_at<>OLD.created_at
     OR OLD.status<>'active' OR NEW.status NOT IN ('active','revoked') THEN
    RAISE EXCEPTION 'QUALIFICATION_APPLICATION_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER qualification_applications_identity_immutable
  BEFORE UPDATE ON qualification_applications
  FOR EACH ROW EXECUTE FUNCTION protect_qualification_application_identity();

CREATE OR REPLACE FUNCTION reject_qualification_application_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'QUALIFICATION_APPLICATION_DELETE_FORBIDDEN';
END $$;

CREATE TRIGGER qualification_applications_no_delete
  BEFORE DELETE ON qualification_applications
  FOR EACH ROW EXECUTE FUNCTION reject_qualification_application_delete();

ALTER TABLE qualification_campaign_authorizations
  ADD COLUMN IF NOT EXISTS canonical_application_id uuid
    REFERENCES qualification_applications(id) ON DELETE RESTRICT;

ALTER TABLE worker_heartbeats
  ADD COLUMN IF NOT EXISTS source_commit text,
  ADD COLUMN IF NOT EXISTS source_dirty boolean,
  ADD COLUMN IF NOT EXISTS source_manifest_sha256 text;

CREATE OR REPLACE FUNCTION enforce_qualification_campaign_application_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  application qualification_applications%ROWTYPE;
  environment_origin text;
BEGIN
  IF NEW.canonical_application_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO application FROM qualification_applications
   WHERE id=NEW.canonical_application_id AND status='active';
  SELECT base_origin INTO environment_origin FROM environments WHERE id=NEW.environment_id;
  IF application.id IS NULL
     OR environment_origin IS NULL
     OR application.project_id<>NEW.project_id
     OR application.environment_id<>NEW.environment_id
     OR application.identity<>NEW.application_identity
     OR application.base_origin<>NEW.target_origin
     OR environment_origin<>NEW.target_origin
     OR NOT application.allowed_origins ? NEW.target_origin THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='QUALIFICATION_APPLICATION_SCOPE_MISMATCH';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS qualification_campaign_application_binding
  ON qualification_campaign_authorizations;
CREATE TRIGGER qualification_campaign_application_binding
  BEFORE INSERT OR UPDATE OF project_id,environment_id,target_origin,application_identity,
    canonical_application_id
  ON qualification_campaign_authorizations
  FOR EACH ROW EXECUTE FUNCTION enforce_qualification_campaign_application_binding();

CREATE TABLE IF NOT EXISTS q5_authoritative_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_key text NOT NULL UNIQUE CHECK (qualification_key='m6-q5-authoritative'),
  campaign_authorization_id uuid NOT NULL UNIQUE
    REFERENCES qualification_campaign_authorizations(id) ON DELETE RESTRICT,
  canonical_application_id uuid NOT NULL REFERENCES qualification_applications(id) ON DELETE RESTRICT,
  external_run_id uuid NOT NULL UNIQUE,
  flow_draft_id uuid NOT NULL REFERENCES flow_drafts(id) ON DELETE RESTRICT,
  flow_revision_id uuid NOT NULL REFERENCES flow_revisions(id) ON DELETE RESTRICT,
  credential_digest text NOT NULL UNIQUE CHECK (credential_digest ~ '^[a-f0-9]{64}$'),
  source_commit text NOT NULL CHECK (source_commit ~ '^[a-f0-9]{40}$'),
  source_manifest text NOT NULL CHECK (source_manifest ~ '^[a-f0-9]{64}$'),
  source_dirty boolean NOT NULL CHECK (source_dirty=false),
  schema_fingerprint text NOT NULL CHECK (schema_fingerprint ~ '^[a-f0-9]{64}$'),
  migration_digest text NOT NULL CHECK (migration_digest ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider='deepseek'),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared','consumed','succeeded','failed','inconclusive','cancelled')),
  provider_request_count integer NOT NULL DEFAULT 0 CHECK (provider_request_count>=0),
  evidence_manifest_digest text CHECK (
    evidence_manifest_digest IS NULL OR evidence_manifest_digest ~ '^[a-f0-9]{64}$'
  ),
  run_id uuid REFERENCES runs(id) ON DELETE RESTRICT,
  praxis_session_id uuid REFERENCES adaptive_sessions(id) ON DELETE RESTRICT,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  terminal_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='prepared' AND consumed_at IS NULL) OR (state<>'prepared' AND consumed_at IS NOT NULL)),
  CHECK ((state IN ('succeeded','failed','inconclusive','cancelled'))=(terminal_at IS NOT NULL)),
  CHECK ((state='succeeded')=(evidence_manifest_digest IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS q5_authoritative_attempt_scope_idx
  ON q5_authoritative_attempts(campaign_authorization_id,canonical_application_id,state);

CREATE OR REPLACE FUNCTION protect_q5_authoritative_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.qualification_key<>OLD.qualification_key
     OR NEW.campaign_authorization_id<>OLD.campaign_authorization_id
     OR NEW.canonical_application_id<>OLD.canonical_application_id
     OR NEW.external_run_id<>OLD.external_run_id
     OR NEW.flow_draft_id<>OLD.flow_draft_id
     OR NEW.flow_revision_id<>OLD.flow_revision_id
     OR NEW.credential_digest<>OLD.credential_digest
     OR NEW.source_commit<>OLD.source_commit
     OR NEW.source_manifest<>OLD.source_manifest
     OR NEW.source_dirty<>OLD.source_dirty
     OR NEW.schema_fingerprint<>OLD.schema_fingerprint
     OR NEW.migration_digest<>OLD.migration_digest
     OR NEW.provider<>OLD.provider OR NEW.model<>OLD.model
     OR NEW.prepared_at<>OLD.prepared_at
     OR NEW.provider_request_count<OLD.provider_request_count
     OR NEW.provider_request_count>OLD.provider_request_count+1
     OR (OLD.evidence_manifest_digest IS NOT NULL
       AND NEW.evidence_manifest_digest IS DISTINCT FROM OLD.evidence_manifest_digest)
     OR (NEW.evidence_manifest_digest IS DISTINCT FROM OLD.evidence_manifest_digest
       AND NOT (OLD.state='consumed' AND NEW.state='succeeded'
         AND OLD.evidence_manifest_digest IS NULL))
     OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)
     OR (OLD.praxis_session_id IS NOT NULL AND NEW.praxis_session_id IS DISTINCT FROM OLD.praxis_session_id)
     OR NOT (
       (OLD.state='prepared' AND NEW.state IN ('prepared','consumed'))
       OR (OLD.state='consumed' AND NEW.state IN ('consumed','succeeded','failed','inconclusive','cancelled'))
       OR (OLD.state IN ('succeeded','failed','inconclusive','cancelled') AND NEW.state=OLD.state)
     ) THEN
    RAISE EXCEPTION 'Q5_AUTHORITATIVE_ATTEMPT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER q5_authoritative_attempts_immutable
  BEFORE UPDATE ON q5_authoritative_attempts
  FOR EACH ROW EXECUTE FUNCTION protect_q5_authoritative_attempt();

CREATE OR REPLACE FUNCTION reject_q5_authoritative_attempt_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Q5_AUTHORITATIVE_ATTEMPT_DELETE_FORBIDDEN';
END $$;

CREATE TRIGGER q5_authoritative_attempts_no_delete
  BEFORE DELETE ON q5_authoritative_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_q5_authoritative_attempt_delete();

COMMENT ON TABLE qualification_applications IS
  'Canonical qualification application/environment authority; caller labels are never authority.';
COMMENT ON TABLE q5_authoritative_attempts IS
  'Singleton durable M6 Q5 paid-attempt fuse. Consumption and terminal failure are irreversible.';
