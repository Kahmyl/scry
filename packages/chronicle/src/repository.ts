import { createHash } from "node:crypto";
import type { ChronicleSqlPort, EvidenceStatus } from "@scry/contracts";

export interface CaptureEvidenceInput {
  effectId: string;
  ownerGeneration: number;
  captureId: string;
  evidenceFormat: number;
  objectKey: string;
  ciphertextDigest: string;
  authenticatedMetadata: Record<string, unknown>;
  contentClass: "http_json" | "http_text" | "http_empty" | "http_binary" | "dom_region";
  byteSize: number;
  structuralIndex: unknown[];
  capturedAt: Date;
  expiresAt: Date;
  encryptedPayload: Buffer;
  encryptedPayloadDigest: string;
  responseStatus?: number;
}

/** Evidence persistence adapter. Mutations use the application's existing locked
 * transaction; this adapter neither admits product actions nor grants disclosure. */
export class ChronicleRepository {
  async lockUnsettledCaptures(sessionId: string) {
    return this.sql.query<{ id: string }>(
      "SELECT id FROM browser_captures WHERE session_id=$1 AND state='durable' ORDER BY captured_at FOR UPDATE",
      [sessionId],
    );
  }

  async captureForPublication(captureId: string, effectId: string) {
    return this.sql.query<{ id: string; structural_index: Array<{ path: unknown }> }>(
      `SELECT id,structural_index FROM browser_captures
         WHERE id=$1 AND effect_id=$2 AND state='durable' AND expires_at>now() FOR UPDATE`,
      [captureId, effectId],
    );
  }

  async captureForDiscard(captureId: string, effectId: string) {
    return this.sql.query<{
      state: string;
      structural_index: Array<{ path: unknown; kind?: string; length?: number }>;
    }>(
      "SELECT state,structural_index FROM browser_captures WHERE id=$1 AND effect_id=$2 FOR UPDATE",
      [captureId, effectId],
    );
  }

  /** Called only inside the application's locked, Veil-admitted transaction. */
  async settleCapture(captureId: string, disposition: "published" | "deleted") {
    if (disposition === "published")
      await this.sql.query(
        "UPDATE browser_captures SET state='published',structural_index='[]'::jsonb,encrypted_payload=NULL,encrypted_payload_digest=NULL WHERE id=$1",
        [captureId],
      );
    else
      await this.sql.query(
        "UPDATE browser_captures SET state='deleted',deleted_at=now(),structural_index='[]'::jsonb,encrypted_payload=NULL,encrypted_payload_digest=NULL WHERE id=$1",
        [captureId],
      );
  }

  validateCaptureEnvelope(input: CaptureEvidenceInput): void {
    if (
      input.encryptedPayload.length === 0 ||
      createHash("sha256").update(input.encryptedPayload).digest("hex") !==
        input.encryptedPayloadDigest
    )
      throw new Error("SCRY_BROWSER_CAPTURE_ENVELOPE_INVALID");
  }

  async registerCapture(input: CaptureEvidenceInput, sessionId: string): Promise<boolean> {
    const existing = await this.sql.query<{
      id: string;
      ciphertext_digest: string;
      encrypted_payload_digest: string;
    }>(
      "SELECT id,ciphertext_digest,encrypted_payload_digest FROM browser_captures WHERE id=$1 FOR UPDATE",
      [input.captureId],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].ciphertext_digest !== input.ciphertextDigest ||
        existing.rows[0].encrypted_payload_digest !== input.encryptedPayloadDigest
      )
        throw new Error("SCRY_BROWSER_CAPTURE_CONFLICT");
      return false;
    }
    await this.sql.query(
      `INSERT INTO browser_captures(id,effect_id,session_id,evidence_format,object_key,ciphertext_digest,
           authenticated_metadata,content_class,byte_size,state,structural_index,captured_at,expires_at,
           encrypted_payload,encrypted_payload_digest)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'durable',$10::jsonb,$11,$12,$13,$14)`,
      [
        input.captureId,
        input.effectId,
        sessionId,
        input.evidenceFormat,
        input.objectKey,
        input.ciphertextDigest,
        JSON.stringify(input.authenticatedMetadata),
        input.contentClass,
        input.byteSize,
        JSON.stringify(input.structuralIndex),
        input.capturedAt,
        input.expiresAt,
        input.encryptedPayload,
        input.encryptedPayloadDigest,
      ],
    );
    return true;
  }

  async durableCapturesForSession(sessionId: string): Promise<
    Array<{
      captureId: string;
      encryptedPayload: Buffer;
      encryptedPayloadDigest: string;
      storedReceipt: Record<string, unknown>;
    }>
  > {
    const result = await this.sql.query<{
      capture_id: string;
      encrypted_payload: Buffer;
      encrypted_payload_digest: string;
      authenticated_metadata: { storedReceipt?: Record<string, unknown> };
    }>(
      `SELECT id AS capture_id,encrypted_payload,encrypted_payload_digest,authenticated_metadata
         FROM browser_captures
        WHERE session_id=$1 AND state='durable'
        ORDER BY captured_at,id`,
      [sessionId],
    );
    return result.rows.map((row) => {
      if (!row.authenticated_metadata.storedReceipt)
        throw new Error("SCRY_BROWSER_CAPTURE_RECEIPT_MISSING");
      return {
        captureId: row.capture_id,
        encryptedPayload: row.encrypted_payload,
        encryptedPayloadDigest: row.encrypted_payload_digest,
        storedReceipt: row.authenticated_metadata.storedReceipt,
      };
    });
  }

  async assertCaptureSlotAvailable(effectId: string, sessionId: string): Promise<void> {
    const result = await this.sql.query<{ id: string }>(
      "SELECT id FROM browser_captures WHERE effect_id=$1 AND session_id=$2 AND state='durable' ORDER BY captured_at LIMIT 1",
      [effectId, sessionId],
    );
    if (result.rows[0]) throw new Error(`SCRY_BROWSER_CAPTURE_UNSETTLED:${result.rows[0].id}`);
  }

  async unsettledCaptureIds(sessionId: string): Promise<string[]> {
    return (
      await this.sql.query<{ id: string }>(
        "SELECT id FROM browser_captures WHERE session_id=$1 AND state='durable' ORDER BY captured_at",
        [sessionId],
      )
    ).rows.map(({ id }) => id);
  }

  constructor(private readonly sql: ChronicleSqlPort) {}

  async evidenceComplete(sessionId: string, lock = false): Promise<boolean> {
    const result = await this.sql.query<{ state: string }>(
      `SELECT state FROM browser_evidence_streams WHERE session_id=$1${lock ? " FOR UPDATE" : ""}`,
      [sessionId],
    );
    return result.rows[0]?.state === "complete";
  }

  async evidenceStatus(sessionId: string, lock = false): Promise<EvidenceStatus | null> {
    const result = await this.sql.query<{
      state: EvidenceStatus["state"];
      sealed: boolean;
      captureStarted: boolean;
      captureStopped: boolean;
      interruptions: number;
      custodyMode: "legacy" | "admitted";
      issue: EvidenceStatus["issue"] | null;
    }>(
      `SELECT state,(sealed_at IS NOT NULL OR (custody_mode='legacy' AND state='complete')) AS sealed,
      capture_started_at IS NOT NULL AS "captureStarted",capture_stopped_at IS NOT NULL AS "captureStopped",
      interruptions,custody_mode AS "custodyMode",closure_issue AS issue FROM browser_evidence_streams WHERE session_id=$1${lock ? " FOR UPDATE" : ""}`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const { issue, ...status } = row;
    return { ...status, ...(issue ? { issue } : {}) };
  }

  async safeActionLedger(
    sessionId: string,
  ): Promise<Array<{ at: string; tool: string; outcome: string; durationMs: number }>> {
    const result = await this.sql.query<{
      kind: string;
      state: string;
      created_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT kind,state,created_at,started_at,completed_at
       FROM browser_commands WHERE session_id=$1 ORDER BY command_ordinal`,
      [sessionId],
    );
    return result.rows.map((row) => {
      const started = row.started_at ?? row.created_at;
      const completed = row.completed_at ?? started;
      return {
        at: started.toISOString(),
        tool: row.kind,
        outcome: row.state,
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
      };
    });
  }

  async appendEffectEvent(
    effectId: string,
    sessionId: string,
    type: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const sequence = await this.sql.query<{ next: string }>(
      "SELECT COALESCE(MAX(sequence),0)+1 AS next FROM browser_effect_events WHERE effect_id=$1",
      [effectId],
    );
    await this.sql.query(
      "INSERT INTO browser_effect_events(effect_id,session_id,sequence,type,safe_details) VALUES($1,$2,$3,$4,$5::jsonb)",
      [
        effectId,
        sessionId,
        required(sequence.rows[0], "SCRY_BROWSER_EVENT_SEQUENCE_FAILED").next,
        type,
        JSON.stringify(details),
      ],
    );
  }

  async recoverEffect(
    effectId: string,
    effect: Record<string, unknown> & { run_id: string; response_status: number | null },
  ): Promise<Record<string, unknown>> {
    const captures = await this.sql.query<{
      id: string;
      content_class: "http_json" | "http_text" | "http_empty" | "http_binary" | "dom_region";
      byte_size: number;
      state: "durable" | "published" | "expired" | "corrupt" | "deleted";
      structural_index: unknown[];
      captured_at: Date;
      expires_at: Date;
    }>(
      `SELECT id,content_class,byte_size,state,structural_index,captured_at,expires_at
       FROM browser_captures WHERE effect_id=$1 ORDER BY (content_class='dom_region'),captured_at,id`,
      [effectId],
    );
    const outputs = await this.sql.query<{
      canonical_name: string;
      classification: "public" | "protected";
      public_value: unknown;
      protected_value_id: string | null;
    }>(
      `SELECT canonical_name,classification,public_value,protected_value_id
       FROM browser_outputs WHERE effect_id=$1 ORDER BY canonical_name`,
      [effectId],
    );
    const publicOutputs: Record<string, unknown> = {};
    const protectedReferences: Record<string, string> = {};
    for (const output of outputs.rows) {
      if (output.classification === "public")
        publicOutputs[output.canonical_name] = output.public_value;
      else if (output.protected_value_id)
        protectedReferences[output.canonical_name] = output.protected_value_id;
    }
    const receipts = captures.rows.map((capture) => ({
      captureId: capture.id,
      runId: effect.run_id,
      effectId,
      phase:
        capture.state === "durable"
          ? "captured"
          : capture.state === "deleted"
            ? "discarded"
            : capture.state,
      status: effect.response_status ?? 200,
      contentType:
        capture.content_class === "dom_region"
          ? "application/vnd.scry.dom+json"
          : capture.content_class === "http_json"
            ? "application/json"
            : "text/plain",
      bodyBytes: capture.byte_size,
      capturedAt: capture.captured_at.toISOString(),
      expiresAt: capture.expires_at.toISOString(),
      structuralIndex: capture.state === "durable" ? capture.structural_index : [],
    }));
    return {
      truth: effect,
      captures: receipts,
      ...(receipts[0] ? { capture: receipts[0] } : {}),
      ...(Object.keys(publicOutputs).length ? { publicOutputs } : {}),
      ...(Object.keys(protectedReferences).length ? { protectedReferences } : {}),
    };
  }

  async listRuns(workspaceId: string | undefined, projectId: string) {
    const result = await this.sql.query(
      `SELECT r.id,r.project_id AS "projectId",r.mission_id AS "missionId",
              r.objective_id AS "objectiveId",r.flow_id AS "flowId",f.name AS "flowName",
              r.state,r.outcome_classification AS "outcomeClassification",
              r.created_at AS "createdAt",r.updated_at AS "updatedAt",r.completed_at AS "completedAt",
              e.name AS "environmentName",e.base_origin AS "baseOrigin",
              s.id AS "browserSessionId",s.state AS "browserSessionState",
              s.active_owner_generation AS "ownerGeneration",
              count(DISTINCT a.id)::integer AS "artifactCount",
              count(DISTINCT es.id) FILTER (WHERE es.state='complete')::integer AS "completeEvidenceStreams"
       FROM runs r
       JOIN projects p ON p.id=r.project_id
       JOIN flows f ON f.id=r.flow_id
       JOIN environments e ON e.id=r.environment_id
       LEFT JOIN browser_execution_sessions s ON s.run_id=r.id
       LEFT JOIN artifacts a ON a.run_id=r.id
       LEFT JOIN browser_evidence_streams es ON es.run_id=r.id
       WHERE r.project_id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)
       GROUP BY r.id,f.name,e.name,e.base_origin,s.id
       ORDER BY r.created_at DESC LIMIT 200`,
      [projectId, workspaceId ?? null],
    );
    return result.rows;
  }

  async runEvidence(runId: string) {
    const [effects, evidence, artifacts] = await Promise.all([
      this.sql.query(
        `SELECT id,effect_class AS "effectClass",effect_ordinal AS "effectOrdinal",
                dispatch_state AS "dispatchState",capture_state AS "captureState",
                publication_state AS "publicationState",mutation_outcome AS "mutationOutcome",
                determination_source AS "reasonCode",admitted_at AS "createdAt",updated_at AS "updatedAt"
         FROM browser_effects WHERE run_id=$1 ORDER BY effect_class,effect_ordinal`,
        [runId],
      ),
      this.sql.query(
        `SELECT id,state,chain_head AS "chainHead",chunk_count AS "chunkCount",
                total_bytes AS "totalBytes",retention_expires_at AS "retentionExpiresAt",
                completed_at AS "completedAt",sealed_at AS "sealedAt",interruptions,
                custody_mode AS "custodyMode",closure_issue AS "closureIssue"
         FROM browser_evidence_streams WHERE run_id=$1 ORDER BY created_at`,
        [runId],
      ),
      this.sql.query(
        `SELECT id,kind,digest,safe_metadata AS "safeMetadata",created_at AS "createdAt"
         FROM artifacts WHERE run_id=$1 ORDER BY created_at`,
        [runId],
      ),
    ]);
    return {
      effects: effects.rows,
      evidence: evidence.rows,
      artifacts: artifacts.rows,
    };
  }

  async missionEvidenceDigest(missionId: string): Promise<string> {
    const evidence = await this.sql.query<{
      chain_head: string | null;
      state: string | null;
      sealed_at: unknown;
      custody_mode: string | null;
    }>(
      `SELECT r.id AS run_id,e.id AS stream_id,e.state,e.chain_head,e.chunk_count,e.total_bytes,
        e.sealed_at,e.interruptions,e.closure_issue,e.custody_mode FROM runs r LEFT JOIN browser_evidence_streams e ON e.run_id=r.id
         WHERE r.mission_id=$1 ORDER BY r.created_at,r.id`,
      [missionId],
    );
    if (
      !evidence.rows.some(
        (row) =>
          row.chain_head &&
          (row.state === "complete" ||
            (row.state === "incomplete" && row.sealed_at && row.custody_mode === "admitted")),
      ) ||
      evidence.rows.some((row) => row.state === "complete" && !row.chain_head)
    )
      throw new Error("SCRY_BROWSER_MISSION_EVIDENCE_INCOMPLETE");
    return createHash("sha256").update(JSON.stringify(evidence.rows)).digest("hex");
  }

  async missionEvidenceCoverage(missionId: string) {
    const result = await this.sql.query<{
      runs: number;
      complete: number;
      incomplete: number;
      open: number;
      missing: number;
      unavailable: number;
    }>(
      `SELECT count(*)::int AS runs,count(*) FILTER(WHERE e.state='complete')::int AS complete,
        count(*) FILTER(WHERE e.state IN ('incomplete','corrupt','expired'))::int AS incomplete,
        count(*) FILTER(WHERE e.state='open')::int AS open,
        count(*) FILTER(WHERE e.id IS NULL)::int AS missing,
        count(*) FILTER(WHERE e.closure_issue IS NOT NULL)::int AS unavailable
        FROM runs r LEFT JOIN browser_evidence_streams e ON e.run_id=r.id WHERE r.mission_id=$1`,
      [missionId],
    );
    return required(result.rows[0], "SCRY_BROWSER_MISSION_EVIDENCE_INCOMPLETE");
  }
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}
