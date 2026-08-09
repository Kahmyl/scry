-- Mission-first hard cutover. owner_* is authoritative after this migration.
ALTER TABLE flows ADD COLUMN IF NOT EXISTS owner_mission_id uuid;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS owner_objective_id uuid;

UPDATE flows f
SET owner_mission_id=f.origin_mission_id,
    owner_objective_id=f.origin_objective_id
WHERE f.owner_mission_id IS NULL
  AND f.origin_mission_id IS NOT NULL
  AND f.origin_objective_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM mission_objectives o
    WHERE o.id=f.origin_objective_id AND o.mission_id=f.origin_mission_id
  );

WITH earliest AS (
  SELECT DISTINCT ON (flow_id) flow_id,mission_id,objective_id
  FROM mission_flow_links
  ORDER BY flow_id,created_at,mission_id
)
UPDATE flows f
SET owner_mission_id=e.mission_id, owner_objective_id=e.objective_id
FROM earliest e
WHERE f.id=e.flow_id AND f.owner_mission_id IS NULL;

-- A consuming Mission receives an immutable imported-revision reference. Mutable
-- Flow ownership remains singular even when legacy links referenced many Missions.
CREATE TABLE IF NOT EXISTS mission_imported_flow_revisions (
  mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  objective_id uuid NOT NULL,
  source_flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE RESTRICT,
  flow_revision_id uuid NOT NULL REFERENCES flow_revisions(id) ON DELETE RESTRICT,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id,source_flow_id),
  FOREIGN KEY (objective_id,mission_id)
    REFERENCES mission_objectives(id,mission_id) ON DELETE CASCADE
);

INSERT INTO mission_imported_flow_revisions(
  mission_id,objective_id,source_flow_id,flow_revision_id,imported_at
)
SELECT l.mission_id,l.objective_id,l.flow_id,f.latest_revision_id,l.created_at
FROM mission_flow_links l
JOIN flows f ON f.id=l.flow_id
WHERE f.owner_mission_id IS NOT NULL
  AND l.mission_id<>f.owner_mission_id
ON CONFLICT (mission_id,source_flow_id) DO NOTHING;

DO $$
DECLARE project_row record;
DECLARE flow_row record;
DECLARE legacy_mission_id uuid;
DECLARE legacy_objective_id uuid;
BEGIN
  FOR project_row IN
    SELECT DISTINCT project_id FROM flows WHERE owner_mission_id IS NULL
  LOOP
    legacy_mission_id := gen_random_uuid();
    INSERT INTO missions(id,project_id,title,original_instruction,status,resume_pointer)
    VALUES(
      legacy_mission_id,project_row.project_id,
      'Legacy imported flows - ' || project_row.project_id::text,
      'Migration-created historical compatibility Mission; review required before Runs.',
      'blocked',
      jsonb_build_object('reasonCode','LEGACY_MISSION_REVIEW_REQUIRED')
    );

    FOR flow_row IN
      SELECT id,name FROM flows
      WHERE project_id=project_row.project_id AND owner_mission_id IS NULL
      ORDER BY created_at,id
    LOOP
      legacy_objective_id := gen_random_uuid();
      INSERT INTO mission_objectives(
        id,mission_id,title,description,status,completion_criteria,objective_order
      )
      VALUES(
        legacy_objective_id,legacy_mission_id,flow_row.name,
        'Migration-created owner for an orphan legacy Flow.','blocked',
        jsonb_build_object('reviewRequired',true),
        (SELECT count(*) FROM mission_objectives WHERE mission_id=legacy_mission_id)
      );
      UPDATE flows SET owner_mission_id=legacy_mission_id,
                       owner_objective_id=legacy_objective_id
      WHERE id=flow_row.id;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE flows
  ADD CONSTRAINT flows_owner_mission_fk
    FOREIGN KEY (owner_mission_id) REFERENCES missions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT flows_owner_objective_mission_fk
    FOREIGN KEY (owner_objective_id,owner_mission_id)
    REFERENCES mission_objectives(id,mission_id) ON DELETE RESTRICT;
ALTER TABLE flows ALTER COLUMN owner_mission_id SET NOT NULL;
ALTER TABLE flows ALTER COLUMN owner_objective_id SET NOT NULL;

CREATE OR REPLACE FUNCTION reject_published_flow_owner_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.owner_mission_id,NEW.owner_objective_id)
       IS DISTINCT FROM (OLD.owner_mission_id,OLD.owner_objective_id)
     AND EXISTS (SELECT 1 FROM flow_revisions WHERE flow_id=OLD.id) THEN
    RAISE EXCEPTION 'Published Flow ownership is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER flows_published_owner_immutable
  BEFORE UPDATE OF owner_mission_id,owner_objective_id ON flows
  FOR EACH ROW EXECUTE FUNCTION reject_published_flow_owner_change();

-- Reconcile legacy active sessions before ownership becomes mandatory.
UPDATE adaptive_sessions s
SET mission_id=d.mission_id, objective_id=d.objective_id
FROM flow_drafts d
WHERE s.flow_draft_id=d.id
  AND (s.mission_id IS NULL OR s.objective_id IS NULL)
  AND d.mission_id IS NOT NULL AND d.objective_id IS NOT NULL;

INSERT INTO adaptive_session_events(session_id,sequence,type,safe_facts,idempotency_key)
SELECT s.id,
       COALESCE((SELECT max(e.sequence) FROM adaptive_session_events e WHERE e.session_id=s.id),0)+1,
       'session_cancelled',
       jsonb_build_object(
         'reasonCode','LEGACY_SESSION_UNOWNED_AT_M1_CUTOVER',
         'migration','mission-first-live-convergence-m1'
       ),
       'mission-first-live-convergence-m1:legacy-unowned-cancelled'
FROM adaptive_sessions s
WHERE (s.mission_id IS NULL OR s.objective_id IS NULL OR s.flow_draft_id IS NULL)
  AND s.state IN ('created','provisioning','active','suspended','recovery_required')
ON CONFLICT (session_id,idempotency_key) DO NOTHING;

UPDATE adaptive_sessions
SET state='cancelled',
    completed_at=COALESCE(completed_at,now()),
    decision_boundary=jsonb_build_object(
      'type','migration_terminalized',
      'reasonCode','LEGACY_SESSION_UNOWNED_AT_M1_CUTOVER',
      'safeActions',jsonb_build_array()
    )
WHERE (mission_id IS NULL OR objective_id IS NULL OR flow_draft_id IS NULL)
  AND state IN ('created','provisioning','active','suspended','recovery_required');

-- Terminal orphan rows cannot participate in the Mission-owned runtime. Preserve
-- them as history while requiring every admitted (nonterminal) row structurally.
ALTER TABLE adaptive_sessions
  ADD CONSTRAINT adaptive_sessions_required_owner_check CHECK (
    state IN ('completed','failed','cancelled') OR
    (mission_id IS NOT NULL AND objective_id IS NOT NULL AND flow_draft_id IS NOT NULL)
  ),
  ADD CONSTRAINT adaptive_sessions_objective_mission_fk
    FOREIGN KEY(objective_id,mission_id)
    REFERENCES mission_objectives(id,mission_id) ON DELETE RESTRICT,
  ADD CONSTRAINT adaptive_sessions_flow_draft_owner_fk
    FOREIGN KEY(flow_draft_id,mission_id,objective_id)
    REFERENCES flow_drafts(id,mission_id,objective_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS flows_owner_listing_idx
  ON flows(owner_mission_id,owner_objective_id,created_at);
CREATE INDEX IF NOT EXISTS adaptive_sessions_owner_idx
  ON adaptive_sessions(mission_id,objective_id,flow_draft_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS mission_imported_flow_revisions_report_idx
  ON mission_imported_flow_revisions(mission_id,objective_id,imported_at);
