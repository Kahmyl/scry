ALTER TABLE environments
  ADD CONSTRAINT environments_id_project_unique UNIQUE(id,project_id);

ALTER TABLE protected_operations
  ADD CONSTRAINT protected_operations_id_owner_unique UNIQUE(id,project_id,environment_id);

ALTER TABLE generated_public_values
  ADD CONSTRAINT generated_public_values_binding_owner_unique
  UNIQUE(id,source_protected_operation_id,project_id);

CREATE TABLE external_resource_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_protected_operation_id uuid NOT NULL,
  generated_public_value_id uuid,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider ~ '^[A-Za-z][A-Za-z0-9_-]{0,99}$'),
  resource_kind text NOT NULL CHECK(resource_kind ~ '^[A-Za-z][A-Za-z0-9_-]{0,99}$'),
  resource_scope text NOT NULL CHECK(length(resource_scope) BETWEEN 1 AND 500),
  canonical_external_identity text,
  identity_contract_version integer NOT NULL CHECK(identity_contract_version BETWEEN 1 AND 1000),
  identity_source text CHECK(identity_source='response'),
  lifecycle_state text NOT NULL CHECK(lifecycle_state IN ('active','unavailable','invalidated','desynchronized')),
  required_for_destructive_lifecycle boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  FOREIGN KEY(source_protected_operation_id,project_id,environment_id)
    REFERENCES protected_operations(id,project_id,environment_id) ON DELETE RESTRICT,
  FOREIGN KEY(environment_id,project_id)
    REFERENCES environments(id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY(generated_public_value_id,source_protected_operation_id,project_id)
    REFERENCES generated_public_values(id,source_protected_operation_id,project_id) ON DELETE RESTRICT,
  CHECK(
    (lifecycle_state='active' AND generated_public_value_id IS NOT NULL
      AND canonical_external_identity IS NOT NULL AND identity_source IS NOT NULL
      AND invalidated_at IS NULL)
    OR (lifecycle_state='unavailable' AND generated_public_value_id IS NULL
      AND canonical_external_identity IS NULL AND identity_source IS NULL
      AND invalidated_at IS NULL)
    OR (lifecycle_state IN ('invalidated','desynchronized') AND invalidated_at IS NOT NULL)
  ),
  UNIQUE(source_protected_operation_id,provider,resource_kind,resource_scope)
);

CREATE UNIQUE INDEX external_resource_bindings_active_identity_unique
  ON external_resource_bindings(
    project_id,environment_id,provider,resource_kind,resource_scope,canonical_external_identity
  ) WHERE lifecycle_state='active';

CREATE INDEX external_resource_bindings_operation_idx
  ON external_resource_bindings(source_protected_operation_id,lifecycle_state);

CREATE OR REPLACE FUNCTION protect_external_resource_binding_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_protected_operation_id<>OLD.source_protected_operation_id
     OR NEW.generated_public_value_id IS DISTINCT FROM OLD.generated_public_value_id
     OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id
     OR NEW.provider<>OLD.provider OR NEW.resource_kind<>OLD.resource_kind
     OR NEW.resource_scope<>OLD.resource_scope
     OR NEW.canonical_external_identity IS DISTINCT FROM OLD.canonical_external_identity
     OR NEW.identity_contract_version<>OLD.identity_contract_version
     OR NEW.identity_source IS DISTINCT FROM OLD.identity_source
     OR NEW.required_for_destructive_lifecycle<>OLD.required_for_destructive_lifecycle
     OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'External resource binding identity is immutable';
  END IF;
  IF OLD.lifecycle_state<>'active' OR NEW.lifecycle_state NOT IN ('invalidated','desynchronized')
     OR NEW.invalidated_at IS NULL THEN
    RAISE EXCEPTION 'External resource binding lifecycle transition is invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER external_resource_bindings_identity_immutable
  BEFORE UPDATE ON external_resource_bindings
  FOR EACH ROW EXECUTE FUNCTION protect_external_resource_binding_identity();

CREATE OR REPLACE FUNCTION reject_external_resource_binding_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'External resource bindings cannot be deleted';
END $$;

CREATE TRIGGER external_resource_bindings_no_delete
  BEFORE DELETE ON external_resource_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_external_resource_binding_delete();

CREATE OR REPLACE FUNCTION project_credential_binding_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.security_status IS DISTINCT FROM OLD.security_status
     AND NEW.security_status IN ('compromised','revoked') THEN
    UPDATE external_resource_bindings
       SET lifecycle_state=CASE WHEN NEW.security_status='revoked' THEN 'invalidated' ELSE 'desynchronized' END,
           invalidated_at=now()
     WHERE source_protected_operation_id=NEW.origin_protected_operation_id
       AND project_id=NEW.project_id AND lifecycle_state='active';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER project_credentials_binding_lifecycle
  AFTER UPDATE OF security_status ON project_credentials
  FOR EACH ROW EXECUTE FUNCTION project_credential_binding_lifecycle();
