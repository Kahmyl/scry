-- Keep admission proportional to the bounded live inventory, not all historical
-- attempts. Existing sessions remain reservations until ordinary finalization.
CREATE INDEX browser_execution_sessions_live_capacity_idx
  ON browser_execution_sessions (id) WHERE state='active';
