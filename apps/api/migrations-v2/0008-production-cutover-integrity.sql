ALTER TABLE browser_owner_generations
  DROP CONSTRAINT browser_owner_generations_runtime_capability_version_check,
  ADD CONSTRAINT browser_owner_generations_runtime_capability_version_check
    CHECK (runtime_capability_version='browser-runtime-v2.7');

ALTER TABLE browser_execution_sessions
  DROP CONSTRAINT browser_execution_sessions_runtime_capability_v26,
  ADD CONSTRAINT browser_execution_sessions_runtime_capability_v27
    CHECK (runtime_capability_version='browser-runtime-v2.7'),
  ADD CONSTRAINT browser_execution_sessions_id_run_unique UNIQUE (id,run_id),
  ADD CONSTRAINT browser_execution_sessions_id_project_unique UNIQUE (id,project_id);

ALTER TABLE browser_commands
  DROP CONSTRAINT browser_commands_session_id_fkey,
  DROP CONSTRAINT browser_commands_run_id_fkey,
  ADD CONSTRAINT browser_commands_session_run_v27_fk
    FOREIGN KEY (session_id,run_id)
    REFERENCES browser_execution_sessions(id,run_id) ON DELETE CASCADE;

ALTER TABLE browser_evidence_streams
  DROP CONSTRAINT browser_evidence_streams_session_id_fkey,
  DROP CONSTRAINT browser_evidence_streams_run_id_fkey,
  ADD CONSTRAINT browser_evidence_streams_session_run_v27_fk
    FOREIGN KEY (session_id,run_id)
    REFERENCES browser_execution_sessions(id,run_id) ON DELETE CASCADE;

ALTER TABLE browser_session_protected_inputs
  ADD COLUMN project_id uuid;

UPDATE browser_session_protected_inputs i
SET project_id=s.project_id
FROM browser_execution_sessions s
WHERE s.id=i.session_id;

ALTER TABLE browser_session_protected_inputs
  ALTER COLUMN project_id SET NOT NULL,
  DROP CONSTRAINT browser_session_protected_inputs_session_id_fkey,
  DROP CONSTRAINT browser_session_protected_inputs_protected_value_id_fkey,
  ADD CONSTRAINT browser_session_protected_inputs_session_project_v27_fk
    FOREIGN KEY (session_id,project_id)
    REFERENCES browser_execution_sessions(id,project_id) ON DELETE CASCADE,
  ADD CONSTRAINT browser_session_protected_inputs_value_project_v27_fk
    FOREIGN KEY (protected_value_id,project_id)
    REFERENCES protected_values(id,project_id) ON DELETE RESTRICT;

ALTER TABLE mission_reports
  ADD CONSTRAINT mission_reports_id_mission_unique UNIQUE (id,mission_id);

ALTER TABLE missions
  DROP CONSTRAINT missions_final_report_v2_fk,
  ADD CONSTRAINT missions_final_report_v27_fk
    FOREIGN KEY (final_report_id,id)
    REFERENCES mission_reports(id,mission_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE schema_baseline
  ADD COLUMN catalog_fingerprint text
    CHECK (catalog_fingerprint IS NULL OR catalog_fingerprint ~ '^[a-f0-9]{64}$');

ALTER TABLE identity_import_receipts
  ADD COLUMN state text NOT NULL DEFAULT 'identity_imported'
    CHECK (state IN ('rehearsal_complete','identity_imported','active')),
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN source_configuration_disposition text NOT NULL DEFAULT 'discarded',
  ADD CONSTRAINT identity_import_receipts_activation_state_v27
    CHECK ((state='active') = (activated_at IS NOT NULL));

UPDATE identity_import_receipts
SET state=CASE WHEN mode='rehearsal' THEN 'rehearsal_complete' ELSE 'identity_imported' END;

UPDATE schema_baseline
SET runtime_capability_version='browser-runtime-v2.7';
