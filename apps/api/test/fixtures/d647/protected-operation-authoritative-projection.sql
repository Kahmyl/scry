CREATE OR REPLACE FUNCTION protect_adaptive_operation_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  durable protected_operations%ROWTYPE;
  durable_count integer;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Adaptive operations cannot be deleted';
  END IF;

  IF NEW.session_id<>OLD.session_id OR NEW.operation_id<>OLD.operation_id
     OR NEW.sequence<>OLD.sequence OR NEW.mode<>OLD.mode
     OR NEW.semantic_intent<>OLD.semantic_intent OR NEW.expected_effect<>OLD.expected_effect
     OR NEW.policy_digest<>OLD.policy_digest OR NEW.started_at<>OLD.started_at
     OR NEW.mission_id IS DISTINCT FROM OLD.mission_id
     OR NEW.objective_id IS DISTINCT FROM OLD.objective_id
     OR NEW.flow_draft_id IS DISTINCT FROM OLD.flow_draft_id
     OR NEW.authoring_intent IS DISTINCT FROM OLD.authoring_intent
     OR NEW.derived_action IS DISTINCT FROM OLD.derived_action
     OR NEW.idempotency_key<>OLD.idempotency_key
     OR NEW.observation_epoch IS DISTINCT FROM OLD.observation_epoch
     OR NEW.candidate_decision_digest IS DISTINCT FROM OLD.candidate_decision_digest
     OR (OLD.capability_manifest_digest IS NOT NULL AND
         NEW.capability_manifest_digest IS DISTINCT FROM OLD.capability_manifest_digest)
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'Adaptive operation identity is immutable';
  END IF;

  IF OLD.state NOT IN ('completed','failed') THEN
    RETURN NEW;
  END IF;

  IF OLD.semantic_intent->>'type'<>'protectedTransaction' THEN
    RAISE EXCEPTION 'Terminal adaptive operations are immutable';
  END IF;

  SELECT count(*),min(protected.id::text)::uuid
    INTO durable_count,durable.id
    FROM protected_operations protected
    JOIN adaptive_sessions session
      ON session.id=OLD.session_id
     AND session.environment_id=protected.environment_id
   WHERE protected.owner_kind='authoring_session'
     AND protected.authoring_session_id=OLD.session_id
     AND protected.operation_id=OLD.operation_id
     AND protected.mission_id=OLD.mission_id
     AND protected.objective_id=OLD.objective_id
     AND protected.flow_draft_id=OLD.flow_draft_id
     AND protected.authorization_id=NULLIF(OLD.authoring_intent->'authorization'->>'authorizationId','')::uuid
     AND protected.state IN ('completed','failed_not_applied','recovery_required','compromised','revoked','abandoned');

  IF durable_count<>1 THEN
    RAISE EXCEPTION 'Terminal adaptive protected projection requires one matching durable operation';
  END IF;

  SELECT * INTO STRICT durable FROM protected_operations WHERE id=durable.id FOR SHARE;

  IF NEW.capability_manifest_digest IS NULL
     OR NEW.evidence_result IS DISTINCT FROM '[]'::jsonb
     OR NEW.quality_findings IS DISTINCT FROM '[]'::jsonb
     OR NEW.safe_outcome IS NULL OR NEW.decision_boundary IS NULL
     OR NEW.safe_outcome->>'operationId'<>OLD.operation_id
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Terminal adaptive protected projection is not canonical';
  END IF;

  IF durable.state='completed' THEN
    IF NEW.state<>'completed' OR NEW.functional_result<>'succeeded'
       OR NEW.mutation_outcome<>'applied' OR NEW.privacy_result<>'sealed'
       OR NEW.dispatch_boundary<>'acknowledged'
       OR NEW.safe_outcome->>'functionalResult'<>'succeeded'
       OR NEW.safe_outcome->>'mutationOutcome'<>'applied'
       OR NEW.safe_outcome->>'privacyResult'<>'sealed'
       OR NEW.decision_boundary->>'type'<>'objective_completed'
       OR jsonb_typeof(NEW.safe_outcome->'generatedReferences')<>'array'
       OR jsonb_array_length(NEW.safe_outcome->'generatedReferences')<>
          (SELECT count(*) FROM jsonb_object_keys(durable.persisted_references))
       OR EXISTS (
         SELECT 1 FROM jsonb_each(durable.persisted_references) stored(reference,value)
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(NEW.safe_outcome->'generatedReferences') projected
             WHERE projected->>'reference'=stored.reference
               AND projected->>'classification'=stored.value->>'classification'
               AND projected->>'scope'='project'
               AND (
                 (stored.value->>'classification'='protected' AND projected->>'credentialId'=stored.value->>'credentialId')
                 OR (stored.value->>'classification'='public' AND projected->>'valueId'=stored.value->>'valueId')
               )
          )
       ) THEN
      RAISE EXCEPTION 'Completed adaptive protected projection disagrees with durable operation';
    END IF;
  ELSIF durable.state='failed_not_applied' THEN
    IF NEW.state<>'failed' OR NEW.functional_result<>'failed'
       OR NEW.mutation_outcome<>'not_applied' OR NEW.privacy_result<>'sealed'
       OR NEW.safe_outcome->>'functionalResult'<>'failed'
       OR NEW.safe_outcome->>'mutationOutcome'<>'not_applied'
       OR NEW.decision_boundary->>'type' NOT IN ('environment_unavailable','policy_refused','ambiguous_candidate')
       OR NEW.safe_outcome ? 'generatedReferences' THEN
      RAISE EXCEPTION 'Failed adaptive protected projection disagrees with durable operation';
    END IF;
  ELSE
    IF NEW.state<>'failed' OR NEW.functional_result<>'inconclusive'
       OR NEW.mutation_outcome<>'unknown' OR NEW.privacy_result<>'sealed'
       OR NEW.safe_outcome->>'functionalResult'<>'inconclusive'
       OR NEW.safe_outcome->>'mutationOutcome'<>'unknown'
       OR NEW.decision_boundary->>'type'<>'mutation_reconciliation_required'
       OR NEW.safe_outcome ? 'generatedReferences' THEN
      RAISE EXCEPTION 'Recovery adaptive protected projection disagrees with durable operation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS adaptive_operations_identity_immutable ON adaptive_operations;
CREATE TRIGGER adaptive_operations_identity_immutable
  BEFORE UPDATE OR DELETE ON adaptive_operations
  FOR EACH ROW EXECUTE FUNCTION protect_adaptive_operation_identity();
