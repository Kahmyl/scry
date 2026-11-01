-- Connected customer mailboxes are not disposable Scry-owned accounts.
ALTER TABLE test_resources
  ADD COLUMN ownership text NOT NULL DEFAULT 'scry' CHECK (ownership IN ('scry','customer')),
  ADD COLUMN connected_address text,
  ADD COLUMN password_credential_id uuid REFERENCES protected_values(id),
  ADD CONSTRAINT test_resource_connection_ownership CHECK (
    (ownership='scry' AND connected_address IS NULL AND password_credential_id IS NULL) OR
    (ownership='customer' AND kind='mailbox' AND connected_address IS NOT NULL AND password_credential_id IS NOT NULL)
  );
CREATE INDEX test_resources_password_credential ON test_resources(password_credential_id);

-- Received access values retain existing Mission scope, not reusable Project
-- credential scope. Preserve receipts and ciphertext while recording that scope.
UPDATE protected_values v SET mission_id=t.mission_id
FROM test_resource_events e JOIN test_resources t ON t.id=e.resource_id
WHERE e.protected_refs @> jsonb_build_array(jsonb_build_object('protectedValueId',v.id::text))
  AND v.project_id=(SELECT project_id FROM missions WHERE id=t.mission_id)
  AND v.source_kind='user_input' AND v.mission_id IS NULL;
