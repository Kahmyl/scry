-- Availability is an immutable closure fact, not a rewrite of capture custody.
-- Existing rows remain NULL; no historical evidence or report is relabelled.
ALTER TABLE browser_evidence_streams ADD COLUMN closure_issue text
  CHECK(closure_issue IN ('object_unavailable','integrity_mismatch','content_unverifiable',
    'video_unavailable','publication_unavailable'));
ALTER TABLE browser_evidence_streams ADD CONSTRAINT evidence_availability_shape CHECK(
  closure_issue IS NULL OR (custody_mode='admitted' AND state='incomplete' AND sealed_at IS NOT NULL AND
    video_artifact_key IS NULL AND ((closure_issue='video_unavailable' AND replay_artifact_key IS NOT NULL) OR
      (closure_issue<>'video_unavailable' AND replay_artifact_key IS NULL))));
ALTER TABLE browser_evidence_streams ADD CONSTRAINT evidence_closure_proof_shape CHECK(
  custody_mode='legacy' OR sealed_at IS NULL OR
    ((capture_stopped_at IS NOT NULL OR capture_started_at IS NULL OR interruptions>0) AND
     (state<>'complete' OR replay_artifact_key IS NOT NULL)));
