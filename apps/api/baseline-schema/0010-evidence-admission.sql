-- Coordinated cutover: stop workers before applying. A live owner makes the
-- entire additive migration refuse, rather than changing its custody protocol.
LOCK TABLE browser_execution_sessions,browser_owner_generations,
  browser_evidence_streams,browser_evidence_chunks IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM browser_owner_generations
    WHERE state='active' AND lease_expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'SCRY_BROWSER_EVIDENCE_LIVE_OWNER' USING ERRCODE='55000';
  END IF;
END $$;

ALTER TABLE browser_owner_generations ADD COLUMN evidence_admission_mode text NOT NULL
  DEFAULT 'unqualified' CHECK(evidence_admission_mode IN ('unqualified','receipts'));
CREATE FUNCTION require_evidence_admission_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.evidence_admission_mode IS DISTINCT FROM OLD.evidence_admission_mode THEN
    RAISE EXCEPTION 'evidence_owner_mode_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state='active' AND NEW.evidence_admission_mode<>'receipts' AND
    (TG_OP='INSERT' OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at) THEN
    RAISE EXCEPTION 'evidence_owner_protocol_required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_admission_owner BEFORE INSERT OR UPDATE ON browser_owner_generations
FOR EACH ROW EXECUTE FUNCTION require_evidence_admission_owner();

ALTER TABLE browser_evidence_streams
  ADD COLUMN custody_mode text NOT NULL DEFAULT 'legacy' CHECK(custody_mode IN ('legacy','admitted')),
  ADD COLUMN writer_generation bigint,
  ADD COLUMN sealed_at timestamptz,
  ADD COLUMN capture_started_at timestamptz,
  ADD COLUMN capture_stopped_at timestamptz,
  ADD COLUMN capture_complete boolean,
  ADD COLUMN interruptions integer NOT NULL DEFAULT 0 CHECK(interruptions>=0);
ALTER TABLE browser_evidence_streams ALTER COLUMN custody_mode SET DEFAULT 'admitted';
ALTER TABLE browser_evidence_streams ADD CONSTRAINT evidence_admitted_shape CHECK(
  custody_mode='legacy' OR (writer_generation>0 AND writer_generation IS NOT NULL AND
    ((capture_stopped_at IS NULL)=(capture_complete IS NULL)) AND
    ((sealed_at IS NULL AND state='open' AND replay_artifact_key IS NULL AND video_artifact_key IS NULL) OR
      (sealed_at IS NOT NULL AND state IN ('complete','incomplete','corrupt','expired'))) AND
    (state<>'complete' OR (sealed_at IS NOT NULL AND capture_started_at IS NOT NULL AND capture_stopped_at IS NOT NULL AND capture_complete IS TRUE AND interruptions=0))));
ALTER TABLE browser_evidence_chunks
  ADD COLUMN owner_generation bigint,
  ADD COLUMN object_digest text CHECK(object_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN object_bytes bigint CHECK(object_bytes>0),
  ADD COLUMN plaintext_bytes bigint CHECK(plaintext_bytes>0);

CREATE FUNCTION preserve_evidence_custody() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'evidence_custody_delete_refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.custody_mode<>'admitted' THEN
      RAISE EXCEPTION 'evidence_legacy_insert_refused' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.custody_mode IS DISTINCT FROM OLD.custody_mode OR OLD.custody_mode='legacy' THEN
      RAISE EXCEPTION 'evidence_legacy_immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.sealed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'evidence_sealed_immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.id<>OLD.id OR NEW.session_id<>OLD.session_id OR NEW.run_id<>OLD.run_id OR
      NEW.interruptions<OLD.interruptions OR
      (OLD.capture_started_at IS NOT NULL AND NEW.capture_started_at IS DISTINCT FROM OLD.capture_started_at) OR
      (OLD.capture_stopped_at IS NOT NULL AND (NEW.capture_stopped_at IS DISTINCT FROM OLD.capture_stopped_at OR NEW.capture_complete IS DISTINCT FROM OLD.capture_complete)) THEN
      RAISE EXCEPTION 'evidence_custody_scope_immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_custody_immutable BEFORE INSERT OR UPDATE OR DELETE ON browser_evidence_streams
FOR EACH ROW EXECUTE FUNCTION preserve_evidence_custody();

CREATE FUNCTION require_evidence_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stream browser_evidence_streams;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'evidence_receipt_immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO stream FROM browser_evidence_streams WHERE id=NEW.stream_id FOR UPDATE;
  IF stream.custody_mode<>'admitted' OR stream.sealed_at IS NOT NULL OR stream.capture_stopped_at IS NOT NULL OR
    NEW.owner_generation IS NULL OR NEW.owner_generation<>stream.writer_generation OR
    NEW.object_digest IS NULL OR NEW.object_bytes IS NULL OR NEW.plaintext_bytes IS NULL OR
    NEW.chunk_index<>stream.chunk_count OR NEW.previous_digest<>coalesce(stream.chain_head,'GENESIS') OR
    NEW.first_sequence<>coalesce((SELECT last_sequence+1 FROM browser_evidence_chunks
      WHERE stream_id=NEW.stream_id ORDER BY chunk_index DESC LIMIT 1),0) THEN
    RAISE EXCEPTION 'evidence_receipt_conflict' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_chunk_receipt BEFORE INSERT OR UPDATE OR DELETE ON browser_evidence_chunks
FOR EACH ROW EXECUTE FUNCTION require_evidence_receipt();

CREATE FUNCTION validate_evidence_summary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_count integer; actual_bytes bigint; actual_head text; broken boolean;
BEGIN
  -- A transaction may admit several chunks; validate its final row, not each
  -- deferred trigger's intermediate NEW tuple.
  SELECT * INTO NEW FROM browser_evidence_streams WHERE id=NEW.id;
  IF NEW.custody_mode='legacy' THEN RETURN NEW; END IF;
  SELECT count(*),coalesce(sum(stored_bytes),0) INTO actual_count,actual_bytes
    FROM browser_evidence_chunks WHERE stream_id=NEW.id;
  SELECT digest INTO actual_head FROM browser_evidence_chunks
    WHERE stream_id=NEW.id ORDER BY chunk_index DESC LIMIT 1;
  SELECT EXISTS(SELECT 1 FROM (SELECT chunk_index,first_sequence,previous_digest,
    row_number() OVER(ORDER BY chunk_index)-1 AS ordinal,
    lag(last_sequence) OVER(ORDER BY chunk_index) AS prior_last,
    lag(digest) OVER(ORDER BY chunk_index) AS prior_digest
    FROM browser_evidence_chunks WHERE stream_id=NEW.id) x
    WHERE chunk_index<>ordinal OR first_sequence<>coalesce(prior_last+1,0) OR
      previous_digest<>coalesce(prior_digest,'GENESIS')) INTO broken;
  IF actual_count<>NEW.chunk_count OR actual_bytes<>NEW.total_bytes OR
    actual_head IS DISTINCT FROM NEW.chain_head OR broken THEN
    RAISE EXCEPTION 'evidence_receipt_summary_mismatch' USING ERRCODE='23514';
  END IF;
  -- Relational writes can themselves wait on constraints or triggers. Decide
  -- against the database clock at the serialized admission point too, not only
  -- before running the metadata statements. The owner row remains locked until
  -- commit, so replacement cannot overtake an accepted receipt.
  IF NOT EXISTS(SELECT 1 FROM browser_owner_generations o
    JOIN browser_execution_sessions s ON s.id=o.session_id
    WHERE o.session_id=NEW.session_id AND o.generation=NEW.writer_generation
      AND o.state='active' AND o.evidence_admission_mode='receipts'
      AND s.state='active' AND s.active_owner_generation=o.generation
      AND o.lease_expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'SCRY_BROWSER_OWNER_FENCED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER evidence_receipt_summary AFTER INSERT OR UPDATE ON browser_evidence_streams
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_evidence_summary();

-- First-class authority, separate from caller report JSON. Existing report
-- bodies/digests remain untouched; NULL means historical coverage was not stored.
ALTER TABLE mission_reports ADD COLUMN evidence_coverage jsonb
  CHECK(evidence_coverage IS NULL OR jsonb_typeof(evidence_coverage)='object');
