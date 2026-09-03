-- Q5 bootstrap correction: generated canonical scope, protected pair provenance,
-- immutable pre-paid preparation, and exact prepared-scope attempt binding.
CREATE TABLE q5_canonical_scope_designations (
  qualification_key text PRIMARY KEY CHECK (qualification_key='m6-q5-authoritative'),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  application_identity text NOT NULL CHECK (application_identity='vitract-preview-test'),
  environment_class text NOT NULL CHECK (environment_class='preview_test'),
  target_origin text NOT NULL CHECK (target_origin='https://preview-api.vitract.com'),
  protected_policy text NOT NULL CHECK (protected_policy='atomic_protected_pair_v1'),
  qualification_policy_version text NOT NULL CHECK (qualification_policy_version='q5-bootstrap-v1'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,environment_id),
  FOREIGN KEY(environment_id,project_id) REFERENCES environments(id,project_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION reject_q5_scope_designation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Q5_CANONICAL_SCOPE_DESIGNATION_IMMUTABLE';
END $$;

CREATE TRIGGER q5_canonical_scope_designations_immutable
  BEFORE UPDATE OR DELETE ON q5_canonical_scope_designations
  FOR EACH ROW EXECUTE FUNCTION reject_q5_scope_designation_mutation();

CREATE TABLE q5_prepared_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_key text NOT NULL UNIQUE CHECK (qualification_key='m6-q5-authoritative'),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  application_identity text NOT NULL CHECK (application_identity='vitract-preview-test'),
  environment_class text NOT NULL CHECK (environment_class='preview_test'),
  target_origin text NOT NULL CHECK (target_origin='https://preview-api.vitract.com'),
  allowed_origins jsonb NOT NULL CHECK (jsonb_typeof(allowed_origins)='array'),
  credential_pair_reference_id uuid NOT NULL,
  client_id_reference_id uuid NOT NULL REFERENCES project_credentials(id) ON DELETE RESTRICT,
  client_secret_reference_id uuid NOT NULL REFERENCES project_credentials(id) ON DELETE RESTRICT,
  issuance_operation_id uuid NOT NULL REFERENCES protected_operations(id) ON DELETE RESTRICT,
  credential_type text NOT NULL CHECK (credential_type='vitract_partner_api_client_pair'),
  protected_policy text NOT NULL CHECK (protected_policy='atomic_protected_pair_v1'),
  credential_provenance text NOT NULL CHECK (credential_provenance='supported_protected_issuance'),
  source_commit text NOT NULL CHECK (source_commit ~ '^[a-f0-9]{40}$'),
  source_manifest text NOT NULL CHECK (source_manifest ~ '^[a-f0-9]{64}$'),
  schema_fingerprint text NOT NULL CHECK (schema_fingerprint ~ '^[a-f0-9]{64}$'),
  migration_identity text NOT NULL CHECK (migration_identity ~ '^[a-f0-9]{64}$'),
  q5_mcp_profile text NOT NULL CHECK (q5_mcp_profile='q5-authoritative-v1'),
  q5_mcp_contract_digest text NOT NULL CHECK (q5_mcp_contract_digest ~ '^[a-f0-9]{64}$'),
  qualification_policy_version text NOT NULL CHECK (qualification_policy_version='q5-bootstrap-v1'),
  binding_digest text NOT NULL UNIQUE CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','invalidated')),
  invalidated_at timestamptz,
  invalidation_reason text CHECK (
    (state='prepared' AND invalidation_reason IS NULL AND invalidated_at IS NULL)
    OR (state='invalidated' AND invalidation_reason ~ '^[A-Z][A-Z0-9_]*$'
      AND invalidated_at IS NOT NULL)
  ),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(environment_id,project_id) REFERENCES environments(id,project_id) ON DELETE RESTRICT,
  CHECK(client_id_reference_id<>client_secret_reference_id)
);

CREATE OR REPLACE FUNCTION protect_q5_prepared_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE'
     OR NEW.id<>OLD.id OR NEW.qualification_key<>OLD.qualification_key
     OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id
     OR NEW.application_identity<>OLD.application_identity OR NEW.environment_class<>OLD.environment_class
     OR NEW.target_origin<>OLD.target_origin OR NEW.allowed_origins<>OLD.allowed_origins
     OR NEW.credential_pair_reference_id<>OLD.credential_pair_reference_id
     OR NEW.client_id_reference_id<>OLD.client_id_reference_id
     OR NEW.client_secret_reference_id<>OLD.client_secret_reference_id
     OR NEW.issuance_operation_id<>OLD.issuance_operation_id
     OR NEW.credential_type<>OLD.credential_type OR NEW.protected_policy<>OLD.protected_policy
     OR NEW.credential_provenance<>OLD.credential_provenance
     OR NEW.source_commit<>OLD.source_commit OR NEW.source_manifest<>OLD.source_manifest
     OR NEW.schema_fingerprint<>OLD.schema_fingerprint OR NEW.migration_identity<>OLD.migration_identity
     OR NEW.q5_mcp_profile<>OLD.q5_mcp_profile OR NEW.q5_mcp_contract_digest<>OLD.q5_mcp_contract_digest
     OR NEW.qualification_policy_version<>OLD.qualification_policy_version
     OR NEW.binding_digest<>OLD.binding_digest OR NEW.prepared_at<>OLD.prepared_at
     OR NOT (
       (OLD.state='prepared' AND NEW.state='prepared'
         AND NEW.invalidation_reason IS NULL AND NEW.invalidated_at IS NULL)
       OR (OLD.state='prepared' AND NEW.state='invalidated'
         AND NEW.invalidation_reason IS NOT NULL AND NEW.invalidated_at IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'Q5_PREPARED_SCOPE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER q5_prepared_scopes_immutable
  BEFORE UPDATE OR DELETE ON q5_prepared_scopes
  FOR EACH ROW EXECUTE FUNCTION protect_q5_prepared_scope();

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM q5_authoritative_attempts) THEN
    RAISE EXCEPTION 'Q5_BOOTSTRAP_MIGRATION_REQUIRES_UNUSED_ATTEMPT';
  END IF;
END $$;

ALTER TABLE q5_authoritative_attempts
  ADD COLUMN prepared_scope_id uuid NOT NULL UNIQUE
    REFERENCES q5_prepared_scopes(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION protect_q5_authoritative_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.qualification_key<>OLD.qualification_key
     OR NEW.campaign_authorization_id<>OLD.campaign_authorization_id
     OR NEW.prepared_scope_id<>OLD.prepared_scope_id
     OR NEW.canonical_application_id<>OLD.canonical_application_id
     OR NEW.external_run_id<>OLD.external_run_id
     OR NEW.flow_draft_id<>OLD.flow_draft_id
     OR NEW.flow_revision_id<>OLD.flow_revision_id
     OR NEW.credential_digest<>OLD.credential_digest
     OR NEW.source_commit<>OLD.source_commit OR NEW.source_manifest<>OLD.source_manifest
     OR NEW.source_dirty<>OLD.source_dirty OR NEW.schema_fingerprint<>OLD.schema_fingerprint
     OR NEW.migration_digest<>OLD.migration_digest OR NEW.provider<>OLD.provider OR NEW.model<>OLD.model
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

COMMENT ON TABLE q5_prepared_scopes IS
  'Immutable pre-paid Q5 scope frozen only after supported canonical provisioning and credential provenance.';
