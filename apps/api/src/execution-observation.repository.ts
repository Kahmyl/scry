import { ConflictException } from "@nestjs/common";
import type { Artifact, PraxisResult, RecordingTimelineEntry, RunEvent } from "@scry/contracts";

import { Database } from "./database.js";

export class ExecutionObservationRepository {
  constructor(private readonly database: Database) {}

  async appendEvent(
    attemptId: string,
    claimToken: string,
    event: Omit<RunEvent, "attemptId" | "runId">,
  ) {
    const result = await this.database.query(
      `INSERT INTO run_events(attempt_id, sequence, type, payload, occurred_at)
       SELECT $1, $3, $4, $5::jsonb, $6
       FROM attempts WHERE id = $1 AND claim_token = $2
       RETURNING id, attempt_id AS "attemptId", sequence, type, payload,
                 occurred_at AS "occurredAt", created_at AS "createdAt"`,
      [
        attemptId,
        claimToken,
        event.sequence,
        event.type,
        JSON.stringify(event.payload),
        event.occurredAt,
      ],
    );
    if (!result.rowCount) throw new ConflictException("Attempt claim was lost");
    return result.rows[0]!;
  }

  async recordGroundingDiagnostic(runId: string, payload: Record<string, unknown>) {
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO grounding_diagnostics(run_id,step_id,intent_digest,outcome,failure_code,candidate_count,eligible_count,confidence,confidence_margin,score_components,rejected_constraints,selected_fingerprint,drift,safe_actions,resolution_source,visual_candidate_count,observation,evidence_families,correlation_groups,degraded_policy,selected_adapter) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb,'unified',$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20)`,
        [
          runId,
          String(payload.stepId ?? "unknown"),
          String(payload.intentDigest),
          payload.outcome === "resolved" ? "resolved" : "rejected",
          payload.code ?? null,
          Number(payload.candidateCount ?? 0),
          Number(payload.eligibleCount ?? 0),
          Number(payload.confidence ?? 0),
          Number(payload.confidenceMargin ?? 0),
          JSON.stringify(payload.score ?? {}),
          JSON.stringify(payload.rejectedConstraints ?? []),
          JSON.stringify(payload.selectedFingerprint ?? null),
          String(payload.drift ?? "unchanged"),
          JSON.stringify(payload.safeActions ?? []),
          Number(payload.visualCandidateCount ?? 0),
          JSON.stringify(
            payload.observation ?? { status: "failed", reasonCode: "DIAGNOSTIC_INCOMPLETE" },
          ),
          JSON.stringify(payload.evidenceFamilies ?? []),
          JSON.stringify(payload.correlationGroups ?? []),
          payload.degradedPolicy ?? null,
          payload.selectedAdapter ?? null,
        ],
      );
      if (payload.outcome === "resolved" && payload.selectedFingerprint)
        await client.query(
          `INSERT INTO semantic_target_history(project_id,environment_id,flow_revision_id,origin,intent_digest,fingerprint,confidence,confidence_margin,drift) SELECT r.project_id,r.environment_id,r.flow_revision_id,e.base_origin,$2,$3::jsonb,$4,$5,$6 FROM runs r JOIN environments e ON e.id=r.environment_id WHERE r.id=$1 ON CONFLICT(project_id,environment_id,flow_revision_id,origin,intent_digest) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,confidence=EXCLUDED.confidence,confidence_margin=EXCLUDED.confidence_margin,drift=EXCLUDED.drift,success_count=semantic_target_history.success_count+1,last_seen_at=now()`,
          [
            runId,
            String(payload.intentDigest),
            JSON.stringify(payload.selectedFingerprint),
            Number(payload.confidence ?? 0),
            Number(payload.confidenceMargin ?? 0),
            String(payload.drift ?? "unchanged"),
          ],
        );
    });
  }

  async recordPraxisResult(runId: string, attemptId: string, result: PraxisResult) {
    await this.database.transaction(async (client) => {
      const completedAt = new Date();
      const startedAt = new Date(completedAt.getTime() - result.timing.totalMs);
      const stored = await client.query(
        `INSERT INTO praxis_transactions(transaction_id,run_id,attempt_id,step_id,operation_id,schema_version,runtime_version,phase,outcome,result,started_at,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,'1',$7,$8,$9::jsonb,$10,$11)
         ON CONFLICT(transaction_id) DO UPDATE SET
           phase=EXCLUDED.phase,outcome=EXCLUDED.outcome,result=EXCLUDED.result,completed_at=EXCLUDED.completed_at,updated_at=now()
         WHERE praxis_transactions.result IS NULL OR praxis_transactions.result=EXCLUDED.result
         RETURNING transaction_id`,
        [
          result.transactionId,
          runId,
          attemptId,
          result.stepId ?? null,
          result.operationId,
          result.schemaVersion,
          result.phase,
          result.status,
          JSON.stringify(result),
          startedAt,
          completedAt,
        ],
      );
      if (!stored.rowCount) throw new ConflictException("Contradictory terminal Praxis result");
      for (const finding of result.qualityFindings)
        await client.query(
          `INSERT INTO praxis_quality_findings(transaction_id,run_id,step_id,intent_digest,finding,artifact_refs)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT DO NOTHING`,
          [
            result.transactionId,
            runId,
            result.stepId ?? null,
            result.report.intentDigest,
            JSON.stringify(finding),
            JSON.stringify(result.report.artifactRefs),
          ],
        );
    });
  }

  async recordAssertion(input: {
    attemptId: string;
    claimToken: string;
    stepId: string;
    assertionIndex: number;
    assertionType: string;
    status: "passed" | "failed" | "unevaluated";
    error?: string;
  }) {
    const result = await this.database.query(
      `INSERT INTO assertion_results(
         attempt_id, step_id, assertion_index, assertion_type, status, error
       )
       SELECT $1, $3, $4, $5, $6, $7
       FROM attempts WHERE id = $1 AND claim_token = $2
       RETURNING id, attempt_id AS "attemptId", step_id AS "stepId",
                 assertion_index AS "assertionIndex", assertion_type AS "assertionType",
                 status, error, created_at AS "createdAt"`,
      [
        input.attemptId,
        input.claimToken,
        input.stepId,
        input.assertionIndex,
        input.assertionType,
        input.status,
        input.error ?? null,
      ],
    );
    if (!result.rowCount) throw new ConflictException("Attempt claim was lost");
    return result.rows[0]!;
  }

  async recordStepResult(input: {
    attemptId: string;
    claimToken: string;
    ordinal: number;
    step: {
      id: string;
      action: { status: string; error?: string };
      readiness?: unknown;
      assertions: Array<{ status: string }>;
      evidence: unknown[];
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
    };
  }) {
    const summary = {
      passed: input.step.assertions.filter(({ status }) => status === "passed").length,
      failed: input.step.assertions.filter(({ status }) => status === "failed").length,
      unevaluated: input.step.assertions.filter(({ status }) => status === "unevaluated").length,
    };
    await this.database.query(
      `INSERT INTO step_results(attempt_id, step_id, ordinal, action_status, action_error,
                                readiness, assertions_summary, evidence, started_at, completed_at, duration_ms)
       SELECT $1, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12
       FROM attempts WHERE id = $1 AND claim_token = $2
       ON CONFLICT (attempt_id, step_id) DO UPDATE SET action_status = EXCLUDED.action_status,
         action_error = EXCLUDED.action_error, readiness = EXCLUDED.readiness,
         assertions_summary = EXCLUDED.assertions_summary, evidence = EXCLUDED.evidence,
         completed_at = EXCLUDED.completed_at, duration_ms = EXCLUDED.duration_ms`,
      [
        input.attemptId,
        input.claimToken,
        input.step.id,
        input.ordinal,
        input.step.action.status,
        input.step.action.error ?? null,
        JSON.stringify(input.step.readiness ?? null),
        JSON.stringify(summary),
        JSON.stringify(input.step.evidence),
        input.step.startedAt ?? null,
        input.step.completedAt ?? null,
        input.step.durationMs ?? null,
      ],
    );
  }

  async recordArtifact(input: {
    attemptId: string;
    claimToken: string;
    stepId?: string;
    artifact: Artifact;
    storageKey?: string;
    retentionUntil?: string;
    contextId?: string;
    captureEpoch?: number;
  }) {
    const availability = input.artifact.availability;
    const privacyClassification = input.artifact.privacyClassification;
    if (availability === "available" && (!input.contextId || input.captureEpoch === undefined))
      throw new ConflictException("AVAILABLE_ARTIFACT_REQUIRES_PROVENANCE");
    if (input.contextId)
      await this.database.query(
        `INSERT INTO browser_contexts(id,run_id,provenance,capture_epoch)
       SELECT $1,run_id,'safe',$3 FROM attempts WHERE id=$2 ON CONFLICT (id) DO NOTHING`,
        [input.contextId, input.attemptId, input.captureEpoch ?? null],
      );
    const result = await this.database.query(
      `INSERT INTO artifacts(
         id, attempt_id, step_id, kind, availability, privacy_classification, content_type, storage_key,
         size_bytes, checksum_sha256, retention_until, metadata, reason_code, context_id, capture_epoch
       )
       SELECT $1, $2, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16
       FROM attempts WHERE id = $2 AND claim_token = $3
       RETURNING id, attempt_id AS "attemptId", step_id AS "stepId", kind, availability,
                 content_type AS "contentType", storage_key AS "storageKey",
                 size_bytes AS "sizeBytes", checksum_sha256 AS "checksumSha256",
                 retention_until AS "retentionUntil", metadata AS observation,
                 created_at AS "createdAt"`,
      [
        input.artifact.id,
        input.attemptId,
        input.claimToken,
        input.stepId ?? null,
        input.artifact.kind,
        availability,
        privacyClassification,
        input.artifact.contentType,
        input.storageKey ?? null,
        input.artifact.sizeBytes ?? null,
        input.artifact.checksumSha256 ?? null,
        input.retentionUntil ?? null,
        JSON.stringify(input.artifact.observation ?? {}),
        input.artifact.reasonCode ?? null,
        input.contextId ?? null,
        input.captureEpoch ?? null,
      ],
    );
    if (!result.rowCount) throw new ConflictException("Attempt claim was lost");
    return result.rows[0]!;
  }

  async recordCaptureEpochs(
    attemptId: string,
    claimToken: string,
    entries: RecordingTimelineEntry[],
  ) {
    for (const entry of entries) {
      if (entry.type !== "capture_epoch") continue;
      const producingProvenance =
        entry.startReason === "checkpoint_restored" ? "restored_safe" : "safe";
      await this.database.transaction(async (client) => {
        const attempt = await client.query(
          `SELECT run_id FROM attempts WHERE id=$1 AND claim_token=$2`,
          [attemptId, claimToken],
        );
        if (!attempt.rowCount) throw new ConflictException("Attempt claim was lost");
        const runId = String(attempt.rows[0]!.run_id);
        await client.query(
          `INSERT INTO browser_contexts(id,run_id,provenance,capture_epoch)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET capture_epoch=GREATEST(COALESCE(browser_contexts.capture_epoch,0),EXCLUDED.capture_epoch)`,
          [entry.contextId, runId, producingProvenance, entry.epoch],
        );
        await client.query(
          `INSERT INTO capture_epochs(run_id,context_id,epoch,producing_provenance,status,started_at,ended_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (context_id,epoch) DO NOTHING`,
          [
            runId,
            entry.contextId,
            entry.epoch,
            producingProvenance,
            entry.status,
            entry.startedAt,
            entry.endedAt,
          ],
        );
      });
    }
  }

  async recordArtifactTimeline(
    attemptId: string,
    claimToken: string,
    entries: RecordingTimelineEntry[],
  ) {
    await this.recordCaptureEpochs(attemptId, claimToken, entries);
    let activeContext: { contextId: string; captureEpoch: number } | undefined;
    for (const entry of entries) {
      if (entry.type === "capture_epoch") {
        activeContext = { contextId: entry.contextId, captureEpoch: entry.epoch };
        await this.database.query(
          `INSERT INTO browser_contexts(id,run_id,provenance,capture_epoch)
           SELECT $1,run_id,'safe',$3 FROM attempts WHERE id=$2
           ON CONFLICT (id) DO UPDATE SET capture_epoch=EXCLUDED.capture_epoch`,
          [entry.contextId, attemptId, entry.epoch],
        );
      }
      const startedAt = "startedAt" in entry ? entry.startedAt : entry.occurredAt;
      const endedAt = "endedAt" in entry ? entry.endedAt : null;
      const artifactId = "artifactId" in entry ? (entry.artifactId ?? null) : null;
      const operationId =
        entry.type === "protected_gap"
          ? entry.operationId
          : entry.type === "checkpoint_boundary"
            ? entry.checkpointId
            : null;
      const channel =
        entry.type === "trace_segment"
          ? "trace"
          : entry.type === "video_segment"
            ? "video"
            : entry.type === "capture_epoch"
              ? "capture"
              : entry.type === "checkpoint_boundary"
                ? "checkpoint"
                : entry.type === "quarantine_record"
                  ? entry.channel
                  : null;
      const reasonCode =
        "failureCode" in entry
          ? (entry.failureCode ?? null)
          : entry.type === "quarantine_record"
            ? entry.reasonCode
            : entry.type === "checkpoint_boundary"
              ? (entry.reasonCode ?? null)
              : null;
      await this.database.query(
        `INSERT INTO artifact_timeline_entries(id, attempt_id, sequence, entry_type, artifact_id, operation_id, channel, started_at, ended_at, reason_code, metadata, context_id, capture_epoch)
         SELECT $1,$2,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14 FROM attempts WHERE id = $2 AND claim_token = $3`,
        [
          entry.id,
          attemptId,
          claimToken,
          entry.sequence,
          entry.type,
          artifactId,
          operationId,
          channel,
          startedAt,
          endedAt,
          reasonCode,
          JSON.stringify(entry),
          activeContext?.contextId ?? null,
          activeContext?.captureEpoch ?? null,
        ],
      );
      if (entry.type === "protected_gap") {
        await this.database.query(
          `INSERT INTO privacy_intervals(attempt_id, operation_id, sequence, mode, started_at, ended_at, terminal_state, safe_boundary_kind)
           SELECT $1,$3,$4,'protected_recording_gap',$5,$6,'safe_to_resume','recording_gap_closed'
           FROM attempts WHERE id = $1 AND claim_token = $2
           ON CONFLICT (attempt_id, operation_id) DO NOTHING`,
          [
            attemptId,
            claimToken,
            entry.operationId,
            entry.sequence,
            entry.startedAt,
            entry.endedAt,
          ],
        );
      }
    }
  }
}
