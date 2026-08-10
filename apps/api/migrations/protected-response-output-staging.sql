CREATE TABLE IF NOT EXISTS protected_response_output_staging (
  protected_operation_id uuid PRIMARY KEY REFERENCES protected_operations(id) ON DELETE RESTRICT,
  operation_id text NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 200),
  ciphertext bytea NOT NULL,
  initialization_vector bytea NOT NULL,
  authentication_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  CHECK(octet_length(ciphertext) BETWEEN 1 AND 524288),
  CHECK(octet_length(initialization_vector)=12),
  CHECK(octet_length(authentication_tag)=16)
);

CREATE INDEX IF NOT EXISTS protected_response_output_staging_expiry_idx
  ON protected_response_output_staging(expires_at);

CREATE OR REPLACE FUNCTION protect_response_output_staging_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.protected_operation_id<>OLD.protected_operation_id
     OR NEW.operation_id<>OLD.operation_id
     OR NEW.ciphertext<>OLD.ciphertext
     OR NEW.initialization_vector<>OLD.initialization_vector
     OR NEW.authentication_tag<>OLD.authentication_tag
     OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Protected response staging is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS protected_response_output_staging_immutable
  ON protected_response_output_staging;
CREATE TRIGGER protected_response_output_staging_immutable
  BEFORE UPDATE ON protected_response_output_staging
  FOR EACH ROW EXECUTE FUNCTION protect_response_output_staging_identity();
