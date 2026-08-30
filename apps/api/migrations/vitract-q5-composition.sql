-- Additive cutover from the legacy two-secret Q5 pair to the canonical typed
-- Vitract pair: generated-safe client identity plus protected client secret.

ALTER TABLE q5_prepared_scopes
  ADD COLUMN IF NOT EXISTS client_id_public_value_id uuid
    REFERENCES generated_public_values(id) ON DELETE RESTRICT;

ALTER TABLE q5_prepared_scopes
  ALTER COLUMN client_id_reference_id DROP NOT NULL;

ALTER TABLE q5_prepared_scopes
  DROP CONSTRAINT IF EXISTS q5_prepared_scopes_check;

ALTER TABLE q5_prepared_scopes
  ADD CONSTRAINT q5_prepared_scope_client_identity_shape CHECK (
    (client_id_public_value_id IS NOT NULL AND client_id_reference_id IS NULL)
    OR (client_id_public_value_id IS NULL AND client_id_reference_id IS NOT NULL)
  );

ALTER TABLE qualification_applications
  ADD COLUMN IF NOT EXISTS typed_value_references jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(typed_value_references)='object');

-- Qualification metadata is authoritative in q5_canonical_scope_designations,
-- not in the strict execution-policy document consumed by Praxis.
UPDATE environments environment
   SET policy=(environment.policy
       - 'q5ApplicationIdentity'
       - 'q5EnvironmentClass'
       - 'q5ProtectedPolicy'
       - 'q5QualificationPolicyVersion')
       || jsonb_build_object(
            'maxDurationMs',LEAST(COALESCE((environment.policy->>'maxDurationMs')::integer,1800000),1800000)
          )
  FROM q5_canonical_scope_designations designation
 WHERE designation.environment_id=environment.id
   AND designation.qualification_key='m6-q5-authoritative';

CREATE OR REPLACE FUNCTION protect_qualification_application_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity<>OLD.identity OR NEW.project_id<>OLD.project_id
     OR NEW.environment_id<>OLD.environment_id OR NEW.base_origin<>OLD.base_origin
     OR NEW.allowed_origins<>OLD.allowed_origins
     OR NEW.credential_reference_ids<>OLD.credential_reference_ids
     OR NEW.typed_value_references<>OLD.typed_value_references
     OR NEW.created_at<>OLD.created_at
     OR OLD.status<>'active' OR NEW.status NOT IN ('active','revoked') THEN
    RAISE EXCEPTION 'QUALIFICATION_APPLICATION_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_q5_prepared_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE'
     OR NEW.id<>OLD.id OR NEW.qualification_key<>OLD.qualification_key
     OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id
     OR NEW.application_identity<>OLD.application_identity OR NEW.environment_class<>OLD.environment_class
     OR NEW.target_origin<>OLD.target_origin OR NEW.allowed_origins<>OLD.allowed_origins
     OR NEW.credential_pair_reference_id<>OLD.credential_pair_reference_id
     OR NEW.client_id_reference_id IS DISTINCT FROM OLD.client_id_reference_id
     OR NEW.client_id_public_value_id IS DISTINCT FROM OLD.client_id_public_value_id
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

COMMENT ON COLUMN q5_prepared_scopes.client_id_public_value_id IS
  'Canonical generated-safe Vitract client identity. Legacy client_id_reference_id remains historical compatibility only.';
COMMENT ON COLUMN qualification_applications.typed_value_references IS
  'Exact typed application inputs. Public generated values are not promoted into the protected credential allowlist.';
