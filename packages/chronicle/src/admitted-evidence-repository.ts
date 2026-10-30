import { evidenceClosureIssues } from "@scry/contracts";
import type {
  ChronicleSqlPort,
  EvidenceChunkReceipt,
  EvidenceCompletion,
  EvidenceStreamSnapshot,
} from "@scry/contracts";

/** Only fixed relational metadata operations. The application supplies an
 * already current-owner-locked transaction; objects are staged before entry. */
export class AdmittedEvidenceRepository {
  constructor(private readonly sql: ChronicleSqlPort) {}

  async snapshot(sessionId: string, lock = true): Promise<EvidenceStreamSnapshot> {
    const result = await this.sql.query<{
      id: string;
      session_id: string;
      run_id: string;
      custody_mode: "legacy" | "admitted";
      state: EvidenceStreamSnapshot["state"];
      writer_generation: string | null;
      chain_head: string | null;
      chunk_count: number;
      total_bytes: string;
      sealed_at: Date | null;
      capture_started_at: Date | null;
      capture_stopped_at: Date | null;
      capture_complete: boolean | null;
      interruptions: number;
    }>(`SELECT * FROM browser_evidence_streams WHERE session_id=$1${lock ? " FOR UPDATE" : ""}`, [
      sessionId,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error("SCRY_BROWSER_EVIDENCE_STREAM_MISSING");
    const chunks = await this.sql.query<{
      stream_id: string;
      owner_generation: string;
      chunk_index: number;
      object_key: string;
      object_digest: string;
      object_bytes: string;
      digest: string;
      previous_digest: string;
      first_sequence: string;
      last_sequence: string;
      plaintext_bytes: string;
      stored_bytes: string;
    }>("SELECT * FROM browser_evidence_chunks WHERE stream_id=$1 ORDER BY chunk_index", [row.id]);
    return {
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      custodyMode: row.custody_mode,
      state: row.state,
      writerGeneration: row.writer_generation === null ? null : Number(row.writer_generation),
      chainHead: row.chain_head,
      chunkCount: row.chunk_count,
      totalBytes: Number(row.total_bytes),
      sealedAt: row.sealed_at?.toISOString() ?? null,
      captureStartedAt: row.capture_started_at?.toISOString() ?? null,
      captureStoppedAt: row.capture_stopped_at?.toISOString() ?? null,
      captureComplete: row.capture_complete,
      interruptions: row.interruptions,
      chunks: chunks.rows.map((chunk) => ({
        streamId: chunk.stream_id,
        ownerGeneration: Number(chunk.owner_generation),
        chunkIndex: chunk.chunk_index,
        objectKey: chunk.object_key,
        objectDigest: chunk.object_digest,
        objectBytes: Number(chunk.object_bytes),
        digest: chunk.digest,
        previousDigest: chunk.previous_digest,
        firstSequence: Number(chunk.first_sequence),
        lastSequence: Number(chunk.last_sequence),
        plaintextBytes: Number(chunk.plaintext_bytes),
        storedBytes: Number(chunk.stored_bytes),
      })),
    };
  }

  async open(
    sessionId: string,
    runId: string,
    generation: number,
  ): Promise<EvidenceStreamSnapshot> {
    await this.sql.query(
      `INSERT INTO browser_evidence_streams(id,session_id,run_id,state,writer_generation,retention_expires_at)
      VALUES(gen_random_uuid(),$1,$2,'open',$3,clock_timestamp()+interval '30 days') ON CONFLICT(session_id) DO NOTHING`,
      [sessionId, runId, generation],
    );
    const snapshot = await this.snapshot(sessionId);
    if (snapshot.runId !== runId) throw new Error("SCRY_BROWSER_EVIDENCE_SCOPE_MISMATCH");
    if (snapshot.custodyMode !== "admitted" || snapshot.sealedAt)
      throw new Error("SCRY_BROWSER_EVIDENCE_READ_ONLY");
    if (snapshot.writerGeneration !== generation) {
      await this.sql.query(
        `UPDATE browser_evidence_streams SET writer_generation=$2,
        interruptions=interruptions+CASE WHEN capture_started_at IS NOT NULL AND capture_stopped_at IS NULL THEN 1 ELSE 0 END,
        updated_at=clock_timestamp() WHERE session_id=$1`,
        [sessionId, generation],
      );
    }
    return this.snapshot(sessionId);
  }

  async admit(sessionId: string, generation: number, chunk: EvidenceChunkReceipt): Promise<void> {
    const s = await this.snapshot(sessionId);
    const positive = [
      chunk.ownerGeneration,
      chunk.objectBytes,
      chunk.plaintextBytes,
      chunk.storedBytes,
    ];
    const nonnegative = [chunk.chunkIndex, chunk.firstSequence, chunk.lastSequence];
    if (
      s.custodyMode !== "admitted" ||
      s.sealedAt ||
      s.captureStoppedAt ||
      s.writerGeneration !== generation ||
      chunk.streamId !== s.id ||
      chunk.ownerGeneration !== generation ||
      positive.some((n) => !Number.isSafeInteger(n) || n <= 0) ||
      nonnegative.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      chunk.lastSequence < chunk.firstSequence ||
      !/^[a-f0-9]{64}$/.test(chunk.objectDigest) ||
      !/^[a-f0-9]{64}$/.test(chunk.digest) ||
      !new RegExp(`^objects/${generation}/[a-f0-9-]{36}\\.json$`).test(chunk.objectKey)
    )
      throw new Error("SCRY_BROWSER_EVIDENCE_RECEIPT_INVALID");
    const existing = s.chunks[chunk.chunkIndex];
    if (existing) {
      if (
        Object.keys(existing).some(
          (key) =>
            existing[key as keyof EvidenceChunkReceipt] !==
            chunk[key as keyof EvidenceChunkReceipt],
        )
      )
        throw new Error("SCRY_BROWSER_EVIDENCE_RECEIPT_CONFLICT");
      return; // exact lost-ack retry never rewinds a later head
    }
    if (
      chunk.chunkIndex !== s.chunkCount ||
      chunk.previousDigest !== (s.chainHead ?? "GENESIS") ||
      chunk.firstSequence !== (s.chunks.at(-1)?.lastSequence ?? -1) + 1
    )
      throw new Error("SCRY_BROWSER_EVIDENCE_RECEIPT_CONFLICT");
    await this.sql.query(
      `INSERT INTO browser_evidence_chunks(stream_id,chunk_index,object_key,digest,previous_digest,
      first_sequence,last_sequence,stored_bytes,owner_generation,object_digest,object_bytes,plaintext_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        s.id,
        chunk.chunkIndex,
        chunk.objectKey,
        chunk.digest,
        chunk.previousDigest,
        chunk.firstSequence,
        chunk.lastSequence,
        chunk.storedBytes,
        generation,
        chunk.objectDigest,
        chunk.objectBytes,
        chunk.plaintextBytes,
      ],
    );
    await this.sql.query(
      `UPDATE browser_evidence_streams SET chain_head=$2,chunk_count=chunk_count+1,
      total_bytes=total_bytes+$3,updated_at=clock_timestamp() WHERE id=$1`,
      [s.id, chunk.digest, chunk.storedBytes],
    );
  }

  async startCapture(sessionId: string, generation: number): Promise<void> {
    const s = await this.snapshot(sessionId);
    if (
      s.writerGeneration !== generation ||
      s.sealedAt ||
      s.captureStoppedAt ||
      s.custodyMode !== "admitted"
    )
      throw new Error("SCRY_BROWSER_EVIDENCE_CAPTURE_CLOSED");
    await this.sql.query(
      "UPDATE browser_evidence_streams SET capture_started_at=coalesce(capture_started_at,clock_timestamp()) WHERE id=$1",
      [s.id],
    );
  }

  async stopCapture(
    sessionId: string,
    generation: number,
    recordingComplete: boolean,
  ): Promise<void> {
    const s = await this.snapshot(sessionId);
    if (s.writerGeneration !== generation || s.sealedAt || s.custodyMode !== "admitted")
      throw new Error("SCRY_BROWSER_EVIDENCE_CAPTURE_CLOSED");
    if (s.captureStoppedAt) {
      if (s.captureComplete !== recordingComplete)
        throw new Error("SCRY_BROWSER_EVIDENCE_STOP_CONFLICT");
      return;
    }
    await this.sql.query(
      `UPDATE browser_evidence_streams SET capture_stopped_at=clock_timestamp(),capture_complete=$2,
      interruptions=interruptions+CASE WHEN $2 THEN 0 ELSE 1 END WHERE id=$1`,
      [s.id, recordingComplete],
    );
  }

  async complete(input: EvidenceCompletion, generation: number): Promise<void> {
    const s = await this.snapshot(input.sessionId);
    if (
      s.custodyMode !== "admitted" ||
      s.runId !== input.runId ||
      s.writerGeneration !== generation ||
      s.chainHead !== input.chainHead ||
      s.chunkCount !== input.chunkCount ||
      s.totalBytes !== input.totalBytes ||
      (input.state !== "complete" && input.state !== "incomplete") ||
      (!s.captureStoppedAt && s.captureStartedAt && s.interruptions === 0) ||
      (input.issue !== undefined && !evidenceClosureIssues.includes(input.issue)) ||
      (input.issue !== undefined &&
        (input.state !== "incomplete" ||
          input.videoObjectKey !== undefined ||
          (input.issue !== "video_unavailable" && input.replayObjectKey !== undefined))) ||
      (input.issue === "video_unavailable" && !input.replayObjectKey) ||
      (input.state === "complete" &&
        (!input.replayObjectKey ||
          input.issue !== undefined ||
          !s.captureStoppedAt ||
          s.captureComplete !== true ||
          s.interruptions !== 0 ||
          !s.captureStartedAt ||
          !s.chainHead ||
          !s.chunkCount))
    )
      throw new Error("SCRY_BROWSER_EVIDENCE_COMPLETION_INVALID");
    if (s.sealedAt) {
      const result = await this.sql.query<{
        replay_artifact_key: string | null;
        video_artifact_key: string | null;
        closure_issue: EvidenceCompletion["issue"] | null;
      }>(
        "SELECT replay_artifact_key,video_artifact_key,closure_issue FROM browser_evidence_streams WHERE id=$1",
        [s.id],
      );
      if (
        s.state !== input.state ||
        result.rows[0]?.replay_artifact_key !== (input.replayObjectKey ?? null) ||
        (result.rows[0]?.closure_issue ?? null) !== (input.issue ?? null) ||
        result.rows[0]?.video_artifact_key !== (input.videoObjectKey ?? null)
      )
        throw new Error("SCRY_BROWSER_EVIDENCE_COMPLETION_CONFLICT");
      return;
    }
    await this.sql.query(
      `UPDATE browser_evidence_streams SET state=$2,sealed_at=clock_timestamp(),
      completed_at=CASE WHEN $2='complete' THEN clock_timestamp() ELSE NULL END,
      replay_artifact_key=$3,video_artifact_key=$4,closure_issue=$5,updated_at=clock_timestamp() WHERE id=$1`,
      [
        s.id,
        input.state,
        input.replayObjectKey ?? null,
        input.videoObjectKey ?? null,
        input.issue ?? null,
      ],
    );
  }
}
