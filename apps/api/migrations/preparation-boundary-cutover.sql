-- Coordinated pre-production cutover from the final-action capsule contract to
-- the compiled protected-transaction program. Existing history remains readable;
-- no pre-cutover calibration can become effective without a new attestation.

ALTER TABLE protected_transactions DROP CONSTRAINT protected_transactions_lifecycle_state_check;
-- Retain the retired aggregate status columns as immutable historical data.
-- Current writers never read or update them; a later pre-production reset removes them.
ALTER TABLE protected_transactions
  ADD COLUMN program_digest text NOT NULL CHECK (program_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN input_schema_digest text NOT NULL CHECK (input_schema_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN bootstrap_status text NOT NULL DEFAULT 'not_started' CHECK (bootstrap_status IN ('not_started','running','succeeded','failed','incomplete')),
  ADD COLUMN preparation_status text NOT NULL DEFAULT 'not_started' CHECK (preparation_status IN ('not_started','running','succeeded','failed','incomplete')),
  ADD COLUMN mutation_dispatch_status text NOT NULL DEFAULT 'not_started' CHECK (mutation_dispatch_status IN ('not_started','authorized','started','acknowledged')),
  ADD COLUMN mutation_outcome_status text NOT NULL DEFAULT 'not_attempted' CHECK (mutation_outcome_status IN ('not_attempted','confirmed_succeeded','confirmed_not_applied','unknown')),
  ADD COLUMN protected_extraction_status text NOT NULL DEFAULT 'not_attempted' CHECK (protected_extraction_status IN ('not_attempted','captured','not_found','failed')),
  ADD COLUMN public_extraction_status text NOT NULL DEFAULT 'not_attempted' CHECK (public_extraction_status IN ('not_attempted','captured','not_found','failed')),
  ADD COLUMN protected_persistence_status text NOT NULL DEFAULT 'not_attempted' CHECK (protected_persistence_status IN ('not_attempted','confirmed','uncertain','failed')),
  ADD COLUMN public_persistence_status text NOT NULL DEFAULT 'not_attempted' CHECK (public_persistence_status IN ('not_attempted','confirmed','uncertain','failed')),
  ADD COLUMN failure_phase text CHECK (failure_phase IN ('bootstrap','preparation','mutation_dispatch','mutation_reconciliation','extraction','persistence','capsule_destruction','continuation')),
  ADD COLUMN retry_class text CHECK (retry_class IN ('safe_to_retry','retry_requires_reconciliation','do_not_retry','manual_review')),
  ADD CONSTRAINT protected_transactions_lifecycle_state_check CHECK (lifecycle_state IN ('planned','safe_context_parking','safe_context_parked','capsule_bootstrapping','bootstrap_failed','capsule_ready','preparation_running','preparation_verified','preparation_failed','dispatch_authorized','mutation_dispatching','mutation_dispatched','capsule_destroying','capsule_destroyed','continuation_establishing','evidence_resumed','continuing_unrecorded','terminal','aborted'));

ALTER TABLE protected_mutation_ledger DROP CONSTRAINT protected_mutation_ledger_state_check;
ALTER TABLE protected_mutation_ledger ADD CONSTRAINT protected_mutation_ledger_state_check
  CHECK (state IN ('planned','dispatch_authorized','dispatching','dispatched','acknowledged','reconciled_succeeded','reconciled_not_applied','outcome_unknown'));

ALTER TABLE calibration_contract_revisions
  ADD COLUMN input_schema_digest text,
  ADD COLUMN input_digest text;
ALTER TABLE calibration_contract_revisions
  ADD CONSTRAINT calibration_contract_revisions_input_schema_digest_check CHECK (input_schema_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT calibration_contract_revisions_input_digest_check CHECK (input_digest ~ '^[a-f0-9]{64}$');

ALTER TABLE calibration_attestations
  ADD COLUMN input_schema_digest text,
  ADD COLUMN input_digest text;
ALTER TABLE calibration_attestations
  ADD CONSTRAINT calibration_attestations_input_schema_digest_check CHECK (input_schema_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT calibration_attestations_input_digest_check CHECK (input_digest ~ '^[a-f0-9]{64}$');

ALTER TABLE calibration_sessions DROP CONSTRAINT calibration_sessions_state_check;
ALTER TABLE calibration_sessions ADD CONSTRAINT calibration_sessions_state_check CHECK (state IN (
  'requested','queued','claimed','preparing','executing_preflight','boundary_reached','arming_privacy',
  'capsule_bootstrapping','preparation_running','preparation_verified','executing_protected_transaction',
  'verifying_safe_exit','scanning_channels','attested','failed','cancelled','expired','sealed','mutation_outcome_unknown'
));
