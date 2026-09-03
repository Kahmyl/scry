ALTER TABLE environments
  ADD COLUMN disclosure_mode text NOT NULL DEFAULT 'confidential'
    CHECK (disclosure_mode IN ('confidential','trusted_application_output')),
  ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX environments_idempotency_v2_idx
  ON environments(project_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE browser_execution_sessions
  ADD COLUMN disclosure_mode text NOT NULL DEFAULT 'confidential'
    CHECK (disclosure_mode IN ('confidential','trusted_application_output'));

CREATE TABLE browser_protection_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id uuid NOT NULL,
  effect_id uuid NOT NULL,
  session_id uuid NOT NULL,
  decision_revision bigint NOT NULL CHECK (decision_revision > 0),
  field_path jsonb NOT NULL CHECK (jsonb_typeof(field_path)='array'),
  canonical_name text NOT NULL CHECK (canonical_name ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$'),
  label text NOT NULL CHECK (label IN ('protected','public')),
  allowed_sinks jsonb NOT NULL CHECK (jsonb_typeof(allowed_sinks)='array'),
  value_digest text NOT NULL CHECK (value_digest ~ '^[a-f0-9]{64}$'),
  decision_digest text NOT NULL CHECK (decision_digest ~ '^[a-f0-9]{64}$'),
  reason_code text NOT NULL,
  public_admission_mode text,
  public_semantic text,
  public_evidence_digest text,
  public_proposal_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (capture_id,effect_id,session_id)
    REFERENCES browser_captures(id,effect_id,session_id) ON DELETE RESTRICT,
  UNIQUE (capture_id,field_path),
  UNIQUE (capture_id,canonical_name),
  UNIQUE (capture_id,decision_digest),
  CONSTRAINT browser_protection_decisions_public_provenance CHECK (
    (label='protected' AND public_admission_mode IS NULL AND public_semantic IS NULL
      AND public_evidence_digest IS NULL AND public_proposal_digest IS NULL)
    OR
    (label='public' AND public_admission_mode='trusted_application_output'
      AND public_semantic ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$'
      AND public_evidence_digest ~ '^[a-f0-9]{64}$'
      AND public_proposal_digest ~ '^[a-f0-9]{64}$')
  )
);

ALTER TABLE browser_publications
  ADD COLUMN decision_set_digest text NOT NULL
    CHECK (decision_set_digest ~ '^[a-f0-9]{64}$');

CREATE INDEX browser_protection_decisions_scope_idx
  ON browser_protection_decisions(session_id,effect_id,capture_id);
