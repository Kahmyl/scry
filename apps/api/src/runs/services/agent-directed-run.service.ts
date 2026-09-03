import path from "node:path";

import { ConflictException, Inject, Injectable, Optional } from "@nestjs/common";
import { createArtifactStoreFromEnv } from "@scry/chronicle/legacy";
import {
  dispatchedRunOperationResultSchema,
  finalizedAgentDirectedRunResultSchema,
  missionAuthoringIntentSchema,
  runPraxisAttachmentResultSchema,
  type OutcomeClassification,
  type VeilPolicySnapshot,
  type AttachRunPraxisSessionInput,
  type DispatchRunOperationInput,
  type DispatchRunPreparedOperationInput,
  type FinalizeAgentDirectedRunInput,
} from "@scry/contracts";

import { ScryRepository } from "../../access/index.js";
import {
  MissionFlowAuthoringService,
  type MissionRunEvidenceContext,
} from "../../adaptive-sessions/index.js";
import type { Principal } from "../../auth/index.js";
import { Database, OperationalEvents } from "../../infrastructure/index.js";
import {
  ExecutionRepository,
  ProtectedOperationRepository,
  QualificationCampaignRepository,
  ReleaseAdmissionService,
} from "../../runtime/index.js";
import { commitExecutionReport } from "../../runtime/report-commit.js";

import { decideLifecycleTransition } from "../../lifecycle/lifecycle-transition.policy.js";

type AssociatedAgentDirectedRun = {
  projectId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  praxisSessionId: string;
  flowDraftId: string | null;
  attemptId: string;
  claimToken: string;
  veilPolicySnapshot: VeilPolicySnapshot;
  praxisState: string;
  praxisDecisionBoundary: { type?: string; reasonCode?: string } | null;
};

type AgentDirectedRunEvidenceContext = MissionRunEvidenceContext & {
  dispatchRefusalCode(): string | undefined;
};

// A Run dispatch contains one semantic operation, but its durable turn also owns
// the post-action report and evidence settlement. Do not use the action's
// timeout as that enclosing turn deadline.
const agentDirectedRunTurnBudgets = { maxOperations: 1, maxDurationMs: 60_000 } as const;

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
    @Inject(ProtectedOperationRepository)
    private readonly protectedOperations: ProtectedOperationRepository,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
    @Inject(QualificationCampaignRepository)
    private readonly qualificationCampaigns: QualificationCampaignRepository,
    @Optional()
    @Inject(OperationalEvents)
    private readonly operationalEvents?: OperationalEvents,
  ) {}

  async dispatchPrepared(
    principal: Principal,
    runId: string,
    input: DispatchRunPreparedOperationInput,
  ) {
    await this.admission.assertAcceptingWork();
    this.scry.requireWriteAccess(principal);
    const run = await this.requireAssociatedRun(principal, runId, input.praxisSessionId, true);
    const authority = await this.database.query(
      `SELECT capability.id FROM prepared_execution_capabilities capability
       JOIN protected_operations operation ON operation.id=capability.protected_operation_id
       WHERE capability.id=$1 AND operation.id=$2 AND operation.operation_id=$3
         AND operation.praxis_session_id=$4 AND capability.project_id=$5 AND capability.mission_id=$6
         AND capability.objective_id=$7 AND capability.agent_session_id=$8`,
      [
        input.preparedExecutionCapabilityId,
        input.protectedOperationId,
        input.publicOperationId,
        input.praxisSessionId,
        run.projectId,
        run.missionId,
        run.objectiveId,
        run.agentSessionId,
      ],
    );
    if (!authority.rowCount)
      throw new ConflictException({ code: "RUN_PREPARED_CAPABILITY_SCOPE_MISMATCH" });
    await this.heartbeatAttempt(run);
    try {
      return await this.sessions.dispatchPreparedOperation(
        principal,
        input.praxisSessionId,
        {
          protectedOperationId: input.protectedOperationId,
          preparedExecutionCapabilityId: input.preparedExecutionCapabilityId,
          publicOperationId: input.publicOperationId,
        },
        this.runEvidenceContext(runId, run),
      );
    } finally {
      await this.refreshCanonicalEvidence(runId);
      const receipt = await this.protectedOperations.getMutationReceiptByAuthoringOperation(
        input.praxisSessionId,
        input.publicOperationId,
      );
      if (receipt && receipt.mutationOutcome !== "not_attempted")
        await this.qualificationCampaigns.settleMutation(
          runId,
          input.publicOperationId,
          receipt.mutationOutcome,
        );
    }
  }

  private refreshCanonicalEvidence(runId: string) {
    // This is a projection of committed truth, not a new authority or replay.
    return this.database.query(
      `UPDATE run_operation_links link SET safe_result=jsonb_build_object(
         'runId',link.run_id,'praxisSessionId',link.praxis_session_id,'operationId',link.operation_id,
         'intentId',link.operation_id,'artifactRefs','[]'::jsonb,'replayed',false,
         'functionalResult',COALESCE(adaptive.functional_result,'inconclusive'),
         'mutationOutcome',CASE WHEN protected.mutation_outcome='not_attempted' THEN 'not_applied' ELSE protected.mutation_outcome END,
         'privacyApplicable',true,'privacyResult',COALESCE(adaptive.privacy_result,'unverified'),
         'evidence',jsonb_build_object('state',CASE WHEN protected.state='completed'
           AND protected.persistence_state='committed' AND protected.failure_code IS NULL
           AND adaptive.state='completed' AND adaptive.functional_result='succeeded'
           AND adaptive.privacy_result='sealed' AND adaptive.evidence_result='[]'::jsonb
           AND adaptive.mutation_outcome=protected.mutation_outcome THEN 'suppressed' ELSE 'failed' END,
           'count',0,'reasonCodes','[]'::jsonb))
       FROM prepared_execution_capabilities capability
       JOIN protected_operations protected ON protected.id=capability.protected_operation_id
       JOIN adaptive_operations adaptive ON adaptive.session_id=protected.praxis_session_id AND adaptive.operation_id=protected.operation_id
       WHERE link.run_id=$1 AND link.prepared_execution_capability_id=capability.id`,
      [runId],
    );
  }

  async dispatch(principal: Principal, runId: string, input: DispatchRunOperationInput) {
    await this.admission.assertAcceptingWork();
    this.scry.requireWriteAccess(principal);
    const run = await this.requireAssociatedRun(principal, runId, input.praxisSessionId, true);
    const existing = await this.database.query<{ safeResult: unknown; operationId: string }>(
      `SELECT link.safe_result AS "safeResult",operation.operation_id AS "operationId" FROM run_operation_links link
       JOIN adaptive_operations operation
         ON operation.session_id=link.praxis_session_id AND operation.operation_id=link.operation_id
       WHERE link.run_id=$1 AND operation.authoring_intent->>'intentId'=$2`,
      [runId, input.intent.intentId],
    );
    if (existing.rowCount) {
      const mutationReceipt = await this.protectedOperations.getMutationReceiptByAuthoringOperation(
        input.praxisSessionId,
        existing.rows[0]!.operationId,
      );
      return dispatchedRunOperationResultSchema.parse({
        ...(existing.rows[0]!.safeResult as object),
        ...(mutationReceipt ? { mutationReceipt } : {}),
        replayed: true,
      });
    }
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
        budgets: agentDirectedRunTurnBudgets,
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
          budgets: agentDirectedRunTurnBudgets,
          idempotencyKey: `${input.intent.intentId}:continue:${attempt + 1}`,
        },
        runEvidence,
      );
    }
    const dispatchRefusalCode = runEvidence.dispatchRefusalCode();
    if (dispatchRefusalCode)
      throw new ConflictException({
        code: dispatchRefusalCode,
        mutationOutcome: "not_applied",
      });
    const operation = result.completed.find((item) => item.intentId === input.intent.intentId);
    if (!operation && result.state === "decision_required" && result.decisionBoundary) {
      throw new ConflictException({
        code: result.decisionBoundary.reasonCode,
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
        safeActions: result.decisionBoundary.safeActions,
        ...(result.decisionBoundary.requiresFreshIntentId ? { requiresFreshIntentId: true } : {}),
        decisionBoundary: result.decisionBoundary,
      });
    }
    if (!operation) throw new ConflictException({ code: "RUN_OPERATION_RESULT_UNAVAILABLE" });
    const persistedOperation = await this.database.query<{ operationId: string }>(
      `SELECT operation_id AS "operationId" FROM adaptive_operations
       WHERE session_id=$1 AND authoring_intent->>'intentId'=$2`,
      [input.praxisSessionId, input.intent.intentId],
    );
    if (!persistedOperation.rowCount)
      throw new ConflictException({ code: "RUN_OPERATION_IDENTITY_UNAVAILABLE" });
    const operationId = persistedOperation.rows[0]!.operationId;
    await this.qualificationCampaigns.settleMutation(runId, operationId, operation.mutationOutcome);
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

    const safeResult = dispatchedRunOperationResultSchema.parse({
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
      ...(operation.semanticPageContext
        ? {
            successorObservation: {
              documentEpoch: operation.semanticPageContext.authority.documentEpoch,
              url: operation.semanticPageContext.authority.url,
              semanticPageContext: operation.semanticPageContext,
            },
          }
        : {}),
      ...(operation.reasonCode ? { reasonCode: operation.reasonCode } : {}),
      ...(result.state === "decision_required" && result.decisionBoundary
        ? { decisionBoundary: result.decisionBoundary }
        : {}),
      replayed: false,
    });
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
    const mutationReceipt = await this.protectedOperations.getMutationReceiptByAuthoringOperation(
      input.praxisSessionId,
      operationId,
    );
    return dispatchedRunOperationResultSchema.parse({
      ...safeResult,
      ...(mutationReceipt ? { mutationReceipt } : {}),
    });
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
    const binding = await this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [runId]);
      const currentRun = await client.query<{ state: string; agentSessionId: string }>(
        `SELECT state,agent_session_id AS "agentSessionId" FROM runs WHERE id=$1 FOR UPDATE`,
        [runId],
      );
      if (currentRun.rows[0]?.state !== "running")
        throw new ConflictException({ code: "RUN_NOT_RUNNING" });
      const replay = await client.query<{ praxisSessionId: string; epoch: number }>(
        `SELECT praxis_session_id AS "praxisSessionId",epoch FROM run_praxis_sessions WHERE run_id=$1 AND idempotency_key=$2`,
        [runId, input.idempotencyKey],
      );
      if (replay.rowCount) {
        if (replay.rows[0]!.praxisSessionId !== input.praxisSessionId)
          throw new ConflictException({ code: "RUN_PRAXIS_ATTACHMENT_IDEMPOTENCY_CONFLICT" });
        return {
          runId,
          praxisSessionId: replay.rows[0]!.praxisSessionId,
          epoch: replay.rows[0]!.epoch,
          replayed: true,
        };
      }
      const session = await client.query(
        `SELECT 1 FROM adaptive_sessions WHERE id=$1 AND project_id=$2 AND mission_id=$3
           AND objective_id=$4 AND environment_id=$5 AND agent_session_id=$6
           AND state IN ('created','provisioning','active','suspended') FOR UPDATE`,
        [
          input.praxisSessionId,
          run.projectId,
          run.missionId,
          run.objectiveId,
          run.environmentId,
          currentRun.rows[0]!.agentSessionId,
        ],
      );
      if (!session.rowCount)
        throw new ConflictException({ code: "RUN_PRAXIS_SESSION_SCOPE_MISMATCH" });
      const liveOwner = await client.query(
        `SELECT session.id FROM run_praxis_sessions binding
         JOIN adaptive_sessions session ON session.id=binding.praxis_session_id
         WHERE binding.run_id=$1 AND binding.detached_at IS NULL
           AND session.state NOT IN ('completed','cancelled','failed','expired') FOR UPDATE OF session`,
        [runId],
      );
      if (liveOwner.rowCount)
        throw new ConflictException({ code: "RUN_PRAXIS_PREVIOUS_OWNER_NOT_TERMINAL" });
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
    return runPraxisAttachmentResultSchema.parse(binding);
  }

  async finalize(principal: Principal, runId: string, input: FinalizeAgentDirectedRunInput) {
    await this.admission.assertAcceptingWork();
    this.scry.requireWriteAccess(principal);

    const run = await this.requireAssociatedRun(principal, runId, input.praxisSessionId, false);
    await this.refreshCanonicalEvidence(runId);
    if (input.outcome === "passed") await this.assertPassEvidenceComplete(runId, run.attemptId);

    // Close a mechanically completed protected owner before final
    // evidence settlement. The canonical completion and privacy checks above
    // prove the boundary; a dead browser must not be asked for another snapshot.
    if (
      input.outcome === "passed" &&
      livePraxisState(run.praxisState) &&
      (await this.resolveTerminalProtectedCompletion(runId, input.praxisSessionId, false))
    )
      await this.sessions.close(principal, input.praxisSessionId, `thin-finalize-${runId}`);

    const outcomeClassification = finalizeOutcomeClassification(input);
    const terminalProtectedCompletion =
      input.outcome === "passed"
        ? await this.resolveTerminalProtectedCompletion(runId, input.praxisSessionId)
        : null;

    const lifecycleDecision = decideLifecycleTransition({
      kind: "complete_run",
      state: input.outcome,
      outcomeClassification,
      terminalProtectedBoundary: terminalProtectedCompletion
        ? {
            kind: "proven",
            praxisSessionId: input.praxisSessionId,
            protectedOperationId: terminalProtectedCompletion.protectedOperationId,
          }
        : { kind: "not_requested" },
    });

    if (!lifecycleDecision.accepted) {
      throw new ConflictException({
        code: lifecycleDecision.code,
        mutationOutcome: "not_applied",
        safeActions: ["get_run"],
      });
    }

    if (lifecycleDecision.successorCheckpoint.kind === "required") {
      if (livePraxisState(run.praxisState)) {
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
      } else {
        await this.assertTerminalProtectedBoundary(runId, run);
      }
    }

    await this.executions.completeAttempt(
      runId,
      run.attemptId,
      run.claimToken,
      input.outcome,
      outcomeClassification,
      lifecycleDecision.successorCheckpoint,
      input.outcome === "passed" ? undefined : input.reason,
    );
    await this.qualificationCampaigns.settleRun(
      runId,
      input.outcome === "passed"
        ? "succeeded"
        : outcomeClassification === "inconclusive_plan" ||
            outcomeClassification === "infrastructure_failure"
          ? "inconclusive"
          : "failed",
    );

    return finalizedAgentDirectedRunResultSchema.parse({
      runId,
      state: input.outcome,
      outcomeClassification,
      reason: input.reason,
    });
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
  ): AgentDirectedRunEvidenceContext {
    let dispatchRefusalCode: string | undefined;
    return {
      veilPolicySnapshot: run.veilPolicySnapshot,

      dispatchRefusalCode: () => dispatchRefusalCode,

      preparedOperationAdmitted: async (operation, preparedExecutionCapabilityId) => {
        await this.database.transaction(async (client) => {
          await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [runId]);
          await client.query(
            `INSERT INTO run_operation_links(run_id,praxis_session_id,operation_id,sequence,safe_result,prepared_execution_capability_id)
             SELECT $1,$2,$3,COALESCE(max(sequence),0)+1,'{}'::jsonb,$4 FROM run_operation_links WHERE run_id=$1
             ON CONFLICT(run_id,operation_id) DO NOTHING`,
            [runId, run.praxisSessionId, operation.operationId, preparedExecutionCapabilityId],
          );
          const linked = await client.query(
            `SELECT 1 FROM run_operation_links WHERE run_id=$1 AND praxis_session_id=$2 AND operation_id=$3 AND prepared_execution_capability_id=$4`,
            [runId, run.praxisSessionId, operation.operationId, preparedExecutionCapabilityId],
          );
          if (!linked.rowCount)
            throw new ConflictException({ code: "RUN_PREPARED_CAPABILITY_BINDING_CONFLICT" });
        });
      },

      beforeBusinessMutationDispatch: async (operation) => {
        try {
          let mutationIdentity: string;
          if (operation.action.type === "protectedTransaction") {
            const authority = await this.database.query<{
              mutationIdentity: string;
              effectSemantics: string[];
            }>(
              `SELECT capability.mutation_identity AS "mutationIdentity",capability.effect_semantics AS "effectSemantics"
               FROM run_operation_links link JOIN prepared_execution_capabilities capability ON capability.id=link.prepared_execution_capability_id
               WHERE link.run_id=$1 AND link.praxis_session_id=$2 AND link.operation_id=$3 AND capability.state='finalized'`,
              [runId, run.praxisSessionId, operation.operationId],
            );
            if (!authority.rowCount)
              throw new ConflictException({ code: "RUN_PREPARED_CAPABILITY_REQUIRED" });
            // Authentication/issuance/read-only acquisition is not a business Create budget.
            if (!authority.rows[0]!.effectSemantics.includes("business_effect")) return;
            mutationIdentity = authority.rows[0]!.mutationIdentity;
          } else {
            mutationIdentity = `adaptive-${run.praxisSessionId}-${operation.idempotencyKey}`;
          }
          const consumption = await this.qualificationCampaigns.consumeBusinessMutation({
            runId,
            operationId: operation.operationId,
            mutationIdentity,
          });
          if (consumption.replayed)
            throw new ConflictException({
              code: "QUALIFICATION_MUTATION_REPLAY_REDISPATCH_FORBIDDEN",
              mutationOutcome: "not_applied",
            });
        } catch (error) {
          dispatchRefusalCode = qualificationCampaignErrorCode(error);
          throw error;
        }
      },

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
          this.evidenceCommitOptions(runId, run),
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

  private evidenceCommitOptions(runId: string, run: AssociatedAgentDirectedRun) {
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
      ...(this.operationalEvents ? { operationalEvents: this.operationalEvents } : {}),
      causality: {
        projectId: run.projectId,
        missionId: run.missionId,
        objectiveId: run.objectiveId,
        agentSessionId: run.agentSessionId,
        runId,
        attemptId: run.attemptId,
        praxisSessionId: run.praxisSessionId,
      },
    };
  }

  private async resolveTerminalProtectedCompletion(
    runId: string,
    praxisSessionId: string,
    requireClosed = true,
  ): Promise<{ protectedOperationId: string } | null> {
    const result = await this.database.query<{ protectedOperationId: string }>(
      `SELECT protected.id AS "protectedOperationId"
         FROM run_praxis_sessions binding
         JOIN adaptive_sessions session
           ON session.id=binding.praxis_session_id
         JOIN LATERAL (
           SELECT link.operation_id,link.prepared_execution_capability_id
             FROM run_operation_links link
            WHERE link.run_id=binding.run_id
              AND link.praxis_session_id=binding.praxis_session_id
            ORDER BY link.sequence DESC,link.created_at DESC
            LIMIT 1
         ) last_link ON true
         JOIN prepared_execution_capabilities capability
           ON capability.id=last_link.prepared_execution_capability_id
         JOIN canonical_completed_executions protected
           ON protected.id=capability.protected_operation_id
          AND protected.operation_id=last_link.operation_id
          AND protected.praxis_session_id=binding.praxis_session_id
        WHERE binding.run_id=$1
          AND binding.praxis_session_id=$2
          AND binding.detached_at IS NULL
          AND (NOT $3::boolean OR session.state='completed' OR (session.state='cancelled'
            AND session.decision_boundary->>'type'='objective_completed'
            AND session.decision_boundary->>'reasonCode'='PROTECTED_OPERATION_COMPLETED'))
        LIMIT 1`,
      [runId, praxisSessionId, requireClosed],
    );

    const row = result.rows[0];
    return result.rowCount &&
      row &&
      typeof row.protectedOperationId === "string" &&
      row.protectedOperationId.length > 0
      ? { protectedOperationId: row.protectedOperationId }
      : null;
  }

  private async assertPassEvidenceComplete(runId: string, attemptId: string) {
    const result = await this.database.query<{
      operationCount: number | string;
      evidencedOperationCount: number | string;
      unacceptableOperationEvidenceCount: number | string;
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
             AND (
               EXISTS(
                 SELECT 1
                 FROM step_results step
                 WHERE step.attempt_id=$2
                   AND position(
                     link.operation_id || '::'
                     in step.step_id
                   )=1
               )
               OR EXISTS(
                 SELECT 1
                 FROM canonical_completed_executions protected
                 WHERE protected.authoring_session_id=link.praxis_session_id
                   AND protected.operation_id=link.operation_id
                   AND protected.prepared_execution_capability_id=link.prepared_execution_capability_id
               )
             )
         ) AS "evidencedOperationCount",
         (
           SELECT count(*)::integer
           FROM run_operation_links link
           WHERE link.run_id=$1
             AND COALESCE(
               link.safe_result->'evidence'->>'state',
               ''
             ) NOT IN (
               'available',
               'suppressed'
             )
         ) AS "unacceptableOperationEvidenceCount",
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
                 AND NOT EXISTS (
                   SELECT 1 FROM artifacts omission
                   WHERE omission.id=artifact_timeline_entries.artifact_id
                     AND omission.attempt_id=$2 AND omission.kind='video'
                     AND omission.availability='destroyed'
                     AND omission.reason_code='VEIL_VIDEO_DOCUMENT_CONTEXT_LOST'
                     AND omission.metadata->>'bytesDestroyed'='true'
                     AND omission.metadata->>'recoverableCaptureLoss'='true'
                 )
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

    const unacceptableOperationEvidenceCount = Number(row?.unacceptableOperationEvidenceCount ?? 0);

    const unsafeArtifactCount = Number(row?.unsafeArtifactCount ?? 0);

    const unsafeTimelineCount = Number(row?.unsafeTimelineCount ?? 0);

    const openPrivacyIntervalCount = Number(row?.openPrivacyIntervalCount ?? 0);

    if (
      operationCount === 0 ||
      evidencedOperationCount !== operationCount ||
      unacceptableOperationEvidenceCount > 0 ||
      unsafeArtifactCount > 0 ||
      unsafeTimelineCount > 0 ||
      openPrivacyIntervalCount > 0
    )
      throw new ConflictException({
        code: "RUN_EVIDENCE_INCOMPLETE",
        mutationOutcome: "not_applied",
        operationCount,
        evidencedOperationCount,
        unacceptableOperationEvidenceCount,
        unsafeArtifactCount,
        unsafeTimelineCount,
        openPrivacyIntervalCount,
        safeActions: ["get_run"],
      });
  }

  private async assertTerminalProtectedBoundary(runId: string, run: AssociatedAgentDirectedRun) {
    if (
      run.praxisState !== "completed" &&
      (run.praxisState !== "cancelled" ||
        run.praxisDecisionBoundary?.type !== "objective_completed" ||
        run.praxisDecisionBoundary.reasonCode !== "PROTECTED_OPERATION_COMPLETED")
    )
      throw terminalPraxisBoundaryUnproven();

    const result = await this.database.query(
      `SELECT 1
       FROM run_operation_links link
       JOIN canonical_completed_executions protected
         ON protected.authoring_session_id=link.praxis_session_id
        AND protected.operation_id=link.operation_id
       WHERE link.run_id=$1
         AND link.praxis_session_id=$2
         AND link.sequence=(
           SELECT max(candidate.sequence)
           FROM run_operation_links candidate
           WHERE candidate.run_id=link.run_id
         )
         AND protected.prepared_execution_capability_id=link.prepared_execution_capability_id`,
      [runId, run.praxisSessionId],
    );

    if (!result.rowCount) throw terminalPraxisBoundaryUnproven();
  }

  private async requireAssociatedRun(
    principal: Principal,
    runId: string,
    praxisSessionId: string,
    requireLive: boolean,
  ): Promise<AssociatedAgentDirectedRun> {
    await this.scry.getRun(principal, runId);

    const result = await this.database.query<{
      projectId: string;
      missionId: string;
      objectiveId: string;
      agentSessionId: string;
      flowDraftId: string | null;
      attemptId: string | null;
      claimToken: string | null;
      veilPolicySnapshot: unknown;
      praxisState: string;
      praxisDecisionBoundary: unknown;
    }>(
      `SELECT
         r.project_id AS "projectId",
         r.mission_id AS "missionId",
         r.objective_id AS "objectiveId",
         r.agent_session_id AS "agentSessionId",
         s.flow_draft_id AS "flowDraftId",
         attempt.id AS "attemptId",
         attempt.claim_token::text AS "claimToken",
         r.veil_policy_snapshot AS "veilPolicySnapshot",
         s.state AS "praxisState",
         s.decision_boundary AS "praxisDecisionBoundary"
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
      projectId: row.projectId,
      missionId: row.missionId,
      objectiveId: row.objectiveId,
      agentSessionId: row.agentSessionId,
      praxisSessionId,
      flowDraftId: row.flowDraftId,
      attemptId: row.attemptId,
      claimToken: row.claimToken,
      veilPolicySnapshot: row.veilPolicySnapshot as VeilPolicySnapshot,
      praxisState: row.praxisState,
      praxisDecisionBoundary: row.praxisDecisionBoundary as {
        type?: string;
        reasonCode?: string;
      } | null,
    };
  }
}

function qualificationCampaignErrorCode(error: unknown) {
  const direct =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const response =
    typeof error === "object" && error !== null && "response" in error ? error.response : undefined;
  const responseCode =
    typeof response === "object" && response !== null && "code" in response
      ? response.code
      : undefined;
  const candidate = String(direct ?? responseCode ?? (error instanceof Error ? error.message : ""));
  return candidate.startsWith("QUALIFICATION_") ? candidate : undefined;
}

function livePraxisState(state: string) {
  return ["created", "provisioning", "active", "suspended"].includes(state);
}

function terminalPraxisBoundaryUnproven() {
  return new ConflictException({
    code: "RUN_TERMINAL_PRAXIS_BOUNDARY_UNPROVEN",
    mutationOutcome: "not_applied",
    safeActions: ["get_run"],
  });
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
