import path from "node:path";

import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { createArtifactStoreFromEnv } from "@scry/chronicle/legacy";
import {
  missionAuthoringIntentSchema,
  type OutcomeClassification,
  type VeilPolicySnapshot,
  type AttachRunPraxisSessionInput,
  type DispatchRunOperationInput,
  type FinalizeAgentDirectedRunInput,
} from "@scry/contracts";

import { ScryRepository } from "../../access/index.js";
import {
  MissionFlowAuthoringService,
  type MissionRunEvidenceContext,
} from "../../adaptive-sessions/index.js";
import type { Principal } from "../../auth/index.js";
import { Database } from "../../infrastructure/index.js";
import { ExecutionRepository, ReleaseAdmissionService } from "../../runtime/index.js";
import { commitExecutionReport } from "../../runtime/report-commit.js";

type AssociatedAgentDirectedRun = {
  objectiveId: string;
  flowDraftId: string | null;
  attemptId: string;
  claimToken: string;
  veilPolicySnapshot: VeilPolicySnapshot;
};

@Injectable()
export class AgentDirectedRunService {
  private readonly artifactRoot = path.resolve(process.env.ARTIFACT_ROOT ?? "artifacts/runs");

  private readonly artifactRetentionMs = Math.max(
    60_000,
    Number(process.env.ARTIFACT_RETENTION_MS ?? 30 * 24 * 60 * 60 * 1_000),
  );

  private artifactStorage?: ReturnType<typeof createArtifactStoreFromEnv>;

  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(ScryRepository) private readonly scry: ScryRepository,
    @Inject(MissionFlowAuthoringService) private readonly sessions: MissionFlowAuthoringService,
    @Inject(ExecutionRepository) private readonly executions: ExecutionRepository,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
  ) {}

  async dispatch(principal: Principal, runId: string, input: DispatchRunOperationInput) {
    await this.admission.assertAcceptingWork();
    this.scry.requireWriteAccess(principal);
    const run = await this.requireAssociatedRun(principal, runId, input.praxisSessionId, true);
    const existing = await this.database.query<{ safeResult: unknown }>(
      `SELECT link.safe_result AS "safeResult" FROM run_operation_links link
       JOIN adaptive_operations operation
         ON operation.session_id=link.praxis_session_id AND operation.operation_id=link.operation_id
       WHERE link.run_id=$1 AND operation.authoring_intent->>'intentId'=$2`,
      [runId, input.intent.intentId],
    );
    if (existing.rowCount) return { ...(existing.rows[0]!.safeResult as object), replayed: true };
    if (
      input.intent.objectiveId !== run.objectiveId ||
      input.intent.flowDraftId !== run.flowDraftId
    )
      throw new ConflictException({ code: "RUN_OPERATION_SCOPE_MISMATCH" });

    await this.heartbeatAttempt(run);
    const runEvidence = this.runEvidenceContext(runId, run);

    const factualIntent = missionAuthoringIntentSchema.parse(input.intent);
    let result = await this.sessions.advance(
      principal,
      input.praxisSessionId,
      {
        kind: "intents",
        idempotencyKey: input.intent.intentId,
        intents: [factualIntent],
        budgets: { maxOperations: 1, maxDurationMs: input.intent.constraints.timeoutMs },
      },
      runEvidence,
    );
    for (let attempt = 0; result.state === "pending" && attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      result = await this.sessions.advance(
        principal,
        input.praxisSessionId,
        {
          kind: "continue",
          turnId: result.turnId,
          budgets: { maxOperations: 1, maxDurationMs: input.intent.constraints.timeoutMs },
          idempotencyKey: `${input.intent.intentId}:continue:${attempt + 1}`,
        },
        runEvidence,
      );
    }
    const operation = result.completed.find((item) => item.intentId === input.intent.intentId);
    if (!operation) throw new ConflictException({ code: "RUN_OPERATION_RESULT_UNAVAILABLE" });
    const persistedOperation = await this.database.query<{ operationId: string }>(
      `SELECT operation_id AS "operationId" FROM adaptive_operations
       WHERE session_id=$1 AND authoring_intent->>'intentId'=$2`,
      [input.praxisSessionId, input.intent.intentId],
    );
    if (!persistedOperation.rowCount)
      throw new ConflictException({ code: "RUN_OPERATION_IDENTITY_UNAVAILABLE" });
    const operationId = persistedOperation.rows[0]!.operationId;

    const artifacts = await this.database.query<{
      id: string;
    }>(
      `SELECT id::text AS id
       FROM artifacts
       WHERE attempt_id=$1
         AND position($2 || '::' in COALESCE(step_id,''))=1
       ORDER BY created_at,id`,
      [run.attemptId, operationId],
    );

    const safeResult = {
      runId,
      praxisSessionId: input.praxisSessionId,
      operationId,
      artifactRefs: artifacts.rows.map(({ id }) => id),
      intentId: operation.intentId,
      functionalResult: operation.functionalResult,
      mutationOutcome: operation.mutationOutcome,
      privacyApplicable: operation.privacyApplicable,
      privacyResult: operation.privacyResult,
      evidence: operation.evidence,
      ...(operation.reasonCode ? { reasonCode: operation.reasonCode } : {}),
      replayed: false,
    };
    await this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [runId]);
      const sequence = await client.query<{ sequence: number }>(
        `SELECT COALESCE(max(sequence),0)::integer+1 sequence
         FROM run_operation_links WHERE run_id=$1`,
        [runId],
      );
      await client.query(
        `INSERT INTO run_operation_links(run_id,praxis_session_id,operation_id,sequence,safe_result)
         VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(run_id,operation_id) DO NOTHING`,
        [
          runId,
          input.praxisSessionId,
          operationId,
          sequence.rows[0]!.sequence,
          JSON.stringify(safeResult),
        ],
      );
      await client.query(`UPDATE runs SET updated_at=now() WHERE id=$1 AND state='running'`, [
        runId,
      ]);
    });
    return safeResult;
  }

  async attach(principal: Principal, runId: string, input: AttachRunPraxisSessionInput) {
    await this.admission.assertAcceptingWork();
    this.scry.requireWriteAccess(principal);
    const run = (await this.scry.getRun(principal, runId)) as Record<string, unknown>;
    if (
      run.executionSnapshot &&
      (run.executionSnapshot as Record<string, unknown>).executionModel !== "agent_directed_v1"
    )
      throw new ConflictException({ code: "RUN_NOT_AGENT_DIRECTED" });
    return this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [runId]);
      const session = await client.query(
        `SELECT 1 FROM adaptive_sessions WHERE id=$1 AND project_id=$2 AND mission_id=$3
           AND objective_id=$4 AND environment_id=$5
           AND state IN ('created','provisioning','active','suspended') FOR UPDATE`,
        [input.praxisSessionId, run.projectId, run.missionId, run.objectiveId, run.environmentId],
      );
      if (!session.rowCount)
        throw new ConflictException({ code: "RUN_PRAXIS_SESSION_SCOPE_MISMATCH" });
      const replay = await client.query(
        `SELECT epoch FROM run_praxis_sessions WHERE run_id=$1 AND idempotency_key=$2`,
        [runId, input.idempotencyKey],
      );
      if (replay.rowCount) return { runId, praxisSessionId: input.praxisSessionId, replayed: true };
      await client.query(
        `UPDATE run_praxis_sessions SET detached_at=now() WHERE run_id=$1 AND detached_at IS NULL`,
        [runId],
      );
      const attached = await client.query<{ epoch: number }>(
        `INSERT INTO run_praxis_sessions(run_id,praxis_session_id,epoch,idempotency_key)
         SELECT $1,$2,COALESCE(max(epoch),0)+1,$3 FROM run_praxis_sessions WHERE run_id=$1
         RETURNING epoch`,
        [runId, input.praxisSessionId, input.idempotencyKey],
      );
      return {
        runId,
        praxisSessionId: input.praxisSessionId,
        epoch: attached.rows[0]!.epoch,
        replayed: false,
      };
    });
  }

  async finalize(principal: Principal, runId: string, input: FinalizeAgentDirectedRunInput) {
    await this.admission.assertAcceptingWork();
    this.scry.requireWriteAccess(principal);

    const run = await this.requireAssociatedRun(
      principal,
      runId,
      input.praxisSessionId,
      input.outcome === "passed",
    );

    if (input.outcome === "passed") {
      await this.assertPassEvidenceComplete(runId, run.attemptId);

      try {
        const checkpoint = await this.sessions.captureRunSuccessorCheckpoint(
          principal,
          input.praxisSessionId,
        );

        await this.executions.stageSuccessorCheckpoint(runId, checkpoint);
      } catch (error) {
        throw new ConflictException({
          code: "SUCCESSOR_CHECKPOINT_ESTABLISHMENT_FAILED",
          reasonCode: successorCheckpointFailureCode(error),
          mutationOutcome: "not_applied",
          safeActions: ["get_run"],
        });
      }
    }

    const outcomeClassification = finalizeOutcomeClassification(input);

    await this.executions.completeAttempt(
      runId,
      run.attemptId,
      run.claimToken,
      input.outcome,
      outcomeClassification,
      input.outcome === "passed" ? undefined : input.reason,
    );

    return {
      runId,
      state: input.outcome,
      outcomeClassification,
      reason: input.reason,
    };
  }

  private async heartbeatAttempt(run: AssociatedAgentDirectedRun) {
    const updated = await this.database.query(
      `UPDATE attempts
       SET heartbeat_at=now()
       WHERE id=$1
         AND claim_token=$2
         AND state='running'
       RETURNING id`,
      [run.attemptId, run.claimToken],
    );

    if (!updated.rowCount)
      throw new ConflictException({
        code: "RUN_EVIDENCE_ATTEMPT_NOT_OPEN",
        mutationOutcome: "not_applied",
      });
  }

  private runEvidenceContext(
    runId: string,
    run: AssociatedAgentDirectedRun,
  ): MissionRunEvidenceContext {
    return {
      veilPolicySnapshot: run.veilPolicySnapshot,

      outputDirectoryFor: (operation) =>
        path.join(this.artifactRoot, runId, encodeURIComponent(operation.operationId)),

      commit: async ({ operation, report, outputDirectory }) => {
        const offsets = await this.database.query<{
          ordinalOffset: number | string;
          timelineSequenceOffset: number | string;
        }>(
          `SELECT
               (
                 SELECT count(*)::integer
                 FROM step_results
                 WHERE attempt_id=$1
               ) AS "ordinalOffset",
               (
                 SELECT COALESCE(max(sequence) + 1,0)::integer
                 FROM artifact_timeline_entries
                 WHERE attempt_id=$1
               ) AS "timelineSequenceOffset"`,
          [run.attemptId],
        );

        const ordinalOffset = Number(offsets.rows[0]?.ordinalOffset ?? 0);

        const timelineSequenceOffset = Number(offsets.rows[0]?.timelineSequenceOffset ?? 0);

        await commitExecutionReport(
          this.evidenceCommitOptions(),
          report,
          outputDirectory,
          run.attemptId,
          run.claimToken,
          {
            stepIdPrefix: operation.operationId,
            ordinalOffset,
            timelineSequenceOffset,
          },
        );

        await this.heartbeatAttempt(run);
      },
    };
  }

  private evidenceCommitOptions() {
    const veilAdmissionKey = process.env.VEIL_ADMISSION_KEY;

    if (!veilAdmissionKey)
      throw new ConflictException({
        code: "VEIL_ADMISSION_KEY_REQUIRED",
        mutationOutcome: "not_applied",
      });

    const storage =
      this.artifactStorage ??
      (this.artifactStorage = createArtifactStoreFromEnv(process.env, veilAdmissionKey));

    return {
      executions: this.executions,
      artifactRoot: this.artifactRoot,
      artifactRetentionMs: this.artifactRetentionMs,
      artifactStore: storage.store,
      artifactStoreRemote: storage.remote,
    };
  }

  private async assertPassEvidenceComplete(runId: string, attemptId: string) {
    const result = await this.database.query<{
      operationCount: number | string;
      evidencedOperationCount: number | string;
      unsafeArtifactCount: number | string;
      unsafeTimelineCount: number | string;
      openPrivacyIntervalCount: number | string;
    }>(
      `SELECT
         (
           SELECT count(*)::integer
           FROM run_operation_links
           WHERE run_id=$1
         ) AS "operationCount",
         (
           SELECT count(DISTINCT link.operation_id)::integer
           FROM run_operation_links link
           WHERE link.run_id=$1
             AND EXISTS(
               SELECT 1
               FROM step_results step
               WHERE step.attempt_id=$2
                 AND position(
                   link.operation_id || '::'
                   in step.step_id
                 )=1
             )
         ) AS "evidencedOperationCount",
         (
           SELECT count(*)::integer
           FROM artifacts
           WHERE attempt_id=$2
             AND availability IN (
               'failed',
               'incomplete',
               'quarantined'
             )
         ) AS "unsafeArtifactCount",
         (
           SELECT count(*)::integer
           FROM artifact_timeline_entries
           WHERE attempt_id=$2
             AND (
               entry_type IN (
                 'unavailable_interval',
                 'quarantine_record'
               )
               OR (
                 entry_type IN (
                   'video_segment',
                   'trace_segment'
                 )
                 AND reason_code IS NOT NULL
               )
             )
         ) AS "unsafeTimelineCount",
         (
           SELECT count(*)::integer
           FROM privacy_intervals
           WHERE attempt_id=$2
             AND ended_at IS NULL
         ) AS "openPrivacyIntervalCount"`,
      [runId, attemptId],
    );

    const row = result.rows[0];

    const operationCount = Number(row?.operationCount ?? 0);

    const evidencedOperationCount = Number(row?.evidencedOperationCount ?? 0);

    const unsafeArtifactCount = Number(row?.unsafeArtifactCount ?? 0);

    const unsafeTimelineCount = Number(row?.unsafeTimelineCount ?? 0);

    const openPrivacyIntervalCount = Number(row?.openPrivacyIntervalCount ?? 0);

    if (
      operationCount === 0 ||
      evidencedOperationCount !== operationCount ||
      unsafeArtifactCount > 0 ||
      unsafeTimelineCount > 0 ||
      openPrivacyIntervalCount > 0
    )
      throw new ConflictException({
        code: "RUN_EVIDENCE_INCOMPLETE",
        mutationOutcome: "not_applied",
        operationCount,
        evidencedOperationCount,
        unsafeArtifactCount,
        unsafeTimelineCount,
        openPrivacyIntervalCount,
        safeActions: ["get_run"],
      });
  }

  private async requireAssociatedRun(
    principal: Principal,
    runId: string,
    praxisSessionId: string,
    requireLive: boolean,
  ): Promise<AssociatedAgentDirectedRun> {
    await this.scry.getRun(principal, runId);

    const result = await this.database.query<{
      objectiveId: string;
      flowDraftId: string | null;
      attemptId: string | null;
      claimToken: string | null;
      veilPolicySnapshot: unknown;
    }>(
      `SELECT
         r.objective_id AS "objectiveId",
         s.flow_draft_id AS "flowDraftId",
         attempt.id AS "attemptId",
         attempt.claim_token::text AS "claimToken",
         r.veil_policy_snapshot AS "veilPolicySnapshot"
       FROM runs r
       JOIN run_praxis_sessions binding
         ON binding.run_id=r.id
        AND binding.detached_at IS NULL
       JOIN adaptive_sessions s
         ON s.id=binding.praxis_session_id
       LEFT JOIN LATERAL (
         SELECT candidate.id,
                candidate.claim_token
         FROM attempts candidate
         WHERE candidate.run_id=r.id
           AND candidate.state='running'
           AND candidate.claim_token IS NOT NULL
         ORDER BY candidate.attempt_number DESC
         LIMIT 1
       ) attempt ON true
       WHERE r.id=$1
         AND r.state='running'
         AND binding.praxis_session_id=$2
         AND (
           $3::boolean=false
           OR s.state IN (
             'created',
             'provisioning',
             'active',
             'suspended'
           )
         )`,
      [runId, praxisSessionId, requireLive],
    );

    if (!result.rowCount)
      throw new ConflictException({
        code: "RUN_PRAXIS_SESSION_MISMATCH_OR_STALE",
      });

    const row = result.rows[0]!;

    if (!row.attemptId || !row.claimToken)
      throw new ConflictException({
        code: "RUN_EVIDENCE_ATTEMPT_UNAVAILABLE",
        mutationOutcome: "not_applied",
      });

    return {
      objectiveId: row.objectiveId,
      flowDraftId: row.flowDraftId,
      attemptId: row.attemptId,
      claimToken: row.claimToken,
      veilPolicySnapshot: row.veilPolicySnapshot as VeilPolicySnapshot,
    };
  }
}

function successorCheckpointFailureCode(error: unknown) {
  const candidate =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : undefined;

  return candidate && /^[A-Z][A-Z0-9_]*$/.test(candidate)
    ? candidate
    : "SUCCESSOR_CHECKPOINT_CAPTURE_FAILED";
}

function finalizeOutcomeClassification(
  input: FinalizeAgentDirectedRunInput,
): OutcomeClassification {
  if (input.outcome === "passed") return "passed";
  if (input.outcome === "cancelled") return "cancelled";
  return input.outcomeClassification ?? "inconclusive_plan";
}
