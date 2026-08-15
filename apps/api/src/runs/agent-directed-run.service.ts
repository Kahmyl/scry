import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  missionAuthoringIntentSchema,
  type AttachRunPraxisSessionInput,
  type DispatchRunOperationInput,
  type FinalizeAgentDirectedRunInput,
} from "@scry/contracts";

import { ScryRepository } from "../access/index.js";
import { MissionFlowAuthoringService } from "../adaptive-sessions/index.js";
import type { Principal } from "../auth/index.js";
import { Database } from "../infrastructure/index.js";
import { ReleaseAdmissionService } from "../runtime/index.js";

@Injectable()
export class AgentDirectedRunService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(ScryRepository) private readonly scry: ScryRepository,
    @Inject(MissionFlowAuthoringService) private readonly sessions: MissionFlowAuthoringService,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
  ) {}

  async dispatch(principal: Principal, runId: string, input: DispatchRunOperationInput) {
    await this.admission.assertAcceptingWork();
    this.scry.requireWriteAccess(principal);
    const run = await this.requireAssociatedRun(principal, runId, input.praxisSessionId, true);
    const existing = await this.database.query<{ safeResult: unknown }>(
      `SELECT safe_result AS "safeResult" FROM run_operation_links
       WHERE run_id=$1 AND operation_id=$2`,
      [runId,input.intent.intentId],
    );
    if (existing.rowCount) return { ...existing.rows[0]!.safeResult as object, replayed: true };
    if (input.intent.objectiveId !== run.objectiveId || input.intent.flowDraftId !== run.flowDraftId)
      throw new ConflictException({ code: "RUN_OPERATION_SCOPE_MISMATCH" });

    const factualIntent = missionAuthoringIntentSchema.parse({
      ...input.intent,
      expectedEffect: { kind: "none" },
    });
    const result = await this.sessions.advance(principal, input.praxisSessionId, {
      kind: "intents",
      idempotencyKey: input.intent.intentId,
      intents: [factualIntent],
      budgets: { maxOperations: 1, maxDurationMs: input.intent.constraints.timeoutMs },
    });
    const operation = result.completed.find((item) => item.intentId === input.intent.intentId);
    if (!operation) throw new ConflictException({ code: "RUN_OPERATION_RESULT_UNAVAILABLE" });
    const safeResult = {
      runId,
      praxisSessionId: input.praxisSessionId,
      operationId: operation.intentId,
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
        [runId,input.praxisSessionId,input.intent.intentId,sequence.rows[0]!.sequence,JSON.stringify(safeResult)],
      );
      await client.query(`UPDATE runs SET updated_at=now() WHERE id=$1 AND state='running'`, [runId]);
    });
    return safeResult;
  }

  async attach(principal: Principal, runId: string, input: AttachRunPraxisSessionInput) {
    await this.admission.assertAcceptingWork();
    this.scry.requireWriteAccess(principal);
    const run = await this.scry.getRun(principal, runId) as Record<string, unknown>;
    if (run.executionSnapshot && (run.executionSnapshot as Record<string, unknown>).executionModel !== "agent_directed_v1")
      throw new ConflictException({ code: "RUN_NOT_AGENT_DIRECTED" });
    return this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [runId]);
      const session = await client.query(
        `SELECT 1 FROM adaptive_sessions WHERE id=$1 AND project_id=$2 AND mission_id=$3
           AND objective_id=$4 AND environment_id=$5
           AND state IN ('created','provisioning','active','suspended') FOR UPDATE`,
        [input.praxisSessionId,run.projectId,run.missionId,run.objectiveId,run.environmentId],
      );
      if (!session.rowCount) throw new ConflictException({ code: "RUN_PRAXIS_SESSION_SCOPE_MISMATCH" });
      const replay = await client.query(
        `SELECT epoch FROM run_praxis_sessions WHERE run_id=$1 AND idempotency_key=$2`,
        [runId,input.idempotencyKey],
      );
      if (replay.rowCount) return { runId,praxisSessionId:input.praxisSessionId,replayed:true };
      await client.query(
        `UPDATE run_praxis_sessions SET detached_at=now() WHERE run_id=$1 AND detached_at IS NULL`,
        [runId],
      );
      const attached = await client.query<{ epoch: number }>(
        `INSERT INTO run_praxis_sessions(run_id,praxis_session_id,epoch,idempotency_key)
         SELECT $1,$2,COALESCE(max(epoch),0)+1,$3 FROM run_praxis_sessions WHERE run_id=$1
         RETURNING epoch`,
        [runId,input.praxisSessionId,input.idempotencyKey],
      );
      return { runId,praxisSessionId:input.praxisSessionId,epoch:attached.rows[0]!.epoch,replayed:false };
    });
  }

  async finalize(principal: Principal, runId: string, input: FinalizeAgentDirectedRunInput) {
    await this.admission.assertAcceptingWork();
    this.scry.requireWriteAccess(principal);
    await this.requireAssociatedRun(principal, runId, input.praxisSessionId, false);
    const classification = input.outcome === "passed" ? "application_pass" : input.outcome === "failed" ? "application_failure" : "cancelled";
    const changed = await this.database.query(
      `UPDATE runs SET state=$2,phase='completed',outcome_classification=$3,
         result_classification=$3,updated_at=now()
       WHERE id=$1 AND state='running' RETURNING id`,
      [runId,input.outcome,classification],
    );
    if (!changed.rowCount) throw new ConflictException({ code: "RUN_NOT_OPEN" });
    return { runId,state:input.outcome,outcomeClassification:classification,reason:input.reason };
  }

  private async requireAssociatedRun(principal: Principal, runId: string, praxisSessionId: string, requireLive: boolean) {
    await this.scry.getRun(principal, runId);
    const result = await this.database.query<{
      objectiveId: string; flowDraftId: string | null;
    }>(
      `SELECT r.objective_id AS "objectiveId",s.flow_draft_id AS "flowDraftId"
       FROM runs r JOIN run_praxis_sessions binding ON binding.run_id=r.id AND binding.detached_at IS NULL
       JOIN adaptive_sessions s ON s.id=binding.praxis_session_id
       WHERE r.id=$1 AND r.state='running' AND binding.praxis_session_id=$2
         AND ($3::boolean=false OR s.state IN ('created','provisioning','active','suspended'))`,
      [runId,praxisSessionId,requireLive],
    );
    if (!result.rowCount)
      throw new ConflictException({ code: "RUN_PRAXIS_SESSION_MISMATCH_OR_STALE" });
    return result.rows[0]!;
  }
}
