-- R0.7 Gate A: explicitly model an intentional ordinary document-navigation
-- recording gap without misclassifying it as a privacy gap or evidence failure.
ALTER TABLE artifact_timeline_entries
  DROP CONSTRAINT IF EXISTS artifact_timeline_entries_entry_type_check;

ALTER TABLE artifact_timeline_entries
  ADD CONSTRAINT artifact_timeline_entries_entry_type_check
  CHECK (
    entry_type IN (
      'video_segment',
      'trace_segment',
      'protected_gap',
      'document_transition_gap',
      'unavailable_interval',
      'quarantine_record',
      'capture_epoch',
      'checkpoint_boundary'
    )
  );
