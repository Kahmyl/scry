-- Saved observations are not raw message archives. Old projections are repaired
-- in the repository before return, atomically with any recovered opaque refs.
-- Default 0 also catches writes from an older binary during rollback.
ALTER TABLE test_resource_events
  ADD COLUMN protection_version integer NOT NULL DEFAULT 0
  CHECK (protection_version >= 0);
