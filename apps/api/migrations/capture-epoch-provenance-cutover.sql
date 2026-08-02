CREATE TABLE capture_epochs (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  context_id uuid NOT NULL REFERENCES browser_contexts(id) ON DELETE RESTRICT,
  epoch integer NOT NULL CHECK (epoch > 0),
  producing_provenance text NOT NULL CHECK (producing_provenance IN ('safe','restored_safe')),
  status text NOT NULL CHECK (status IN ('completed','sealed')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  PRIMARY KEY (context_id, epoch),
  UNIQUE (run_id, context_id, epoch)
);

INSERT INTO capture_epochs(run_id,context_id,epoch,producing_provenance,status,started_at,ended_at)
SELECT DISTINCT a.run_id, artifact.context_id, artifact.capture_epoch,
       CASE WHEN context.provenance = 'restored_safe' THEN 'restored_safe' ELSE 'safe' END,
       'sealed', artifact.created_at, artifact.created_at
  FROM artifacts artifact
  JOIN attempts a ON a.id = artifact.attempt_id
  JOIN browser_contexts context ON context.id = artifact.context_id
 WHERE artifact.context_id IS NOT NULL AND artifact.capture_epoch IS NOT NULL
ON CONFLICT (context_id,epoch) DO NOTHING;

ALTER TABLE artifacts ADD CONSTRAINT artifacts_capture_epoch_fk
  FOREIGN KEY (context_id, capture_epoch) REFERENCES capture_epochs(context_id, epoch) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION enforce_safe_artifact_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE epoch_provenance text;
BEGIN
  IF NEW.availability = 'available' THEN
    IF NEW.context_id IS NULL OR NEW.capture_epoch IS NULL THEN RAISE EXCEPTION 'AVAILABLE_ARTIFACT_REQUIRES_PROVENANCE'; END IF;
    SELECT producing_provenance INTO epoch_provenance
      FROM capture_epochs WHERE context_id = NEW.context_id AND epoch = NEW.capture_epoch AND status IN ('completed','sealed');
    IF epoch_provenance NOT IN ('safe','restored_safe') THEN RAISE EXCEPTION 'PROTECTED_CONTEXT_ARTIFACT_REJECTED'; END IF;
  END IF;
  RETURN NEW;
END $$;
