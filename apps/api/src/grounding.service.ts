import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ProtectedRecoveryCommand } from "@scry/contracts";
import type { Principal } from "./auth.types.js";
import { Database } from "./database.js";

@Injectable()
export class GroundingService {
  constructor(@Inject(Database) private readonly database: Database) {}
  async diagnostics(principal: Principal, runId: string) {
    const access = await this.database.query(`SELECT 1 FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`, [runId, workspaceId(principal)]);
    if (!access.rowCount) throw new NotFoundException("Run not found");
    return (await this.database.query(`SELECT id,step_id AS "stepId",outcome,failure_code AS "failureCode",candidate_count AS "candidateCount",eligible_count AS "eligibleCount",confidence,confidence_margin AS "confidenceMargin",score_components AS "scoreComponents",rejected_constraints AS "rejectedConstraints",selected_fingerprint AS "selectedFingerprint",drift,safe_actions AS "safeActions",resolution_source AS "resolutionSource",visual_candidate_count AS "visualCandidateCount",observation,evidence_families AS "evidenceFamilies",correlation_groups AS "correlationGroups",degraded_policy AS "degradedPolicy",selected_adapter AS "selectedAdapter",created_at AS "createdAt" FROM grounding_diagnostics WHERE run_id=$1 ORDER BY created_at`, [runId])).rows;
  }
  async protectedRecovery(principal: Principal, runId: string, operationId: string, input: ProtectedRecoveryCommand) {
    if (principal.kind === "service") throw new ForbiddenException("Write access required");
    return this.database.transaction(async (client) => {
      const context = await client.query<{ state: string }>(`SELECT pt.lifecycle_state state FROM protected_transactions pt JOIN runs r ON r.id=pt.run_id JOIN projects p ON p.id=r.project_id JOIN agent_sessions s ON s.id=$6 AND s.mission_id=r.mission_id AND s.status='active' WHERE pt.run_id=$1 AND pt.operation_id=$2 AND r.mission_id=$3 AND r.objective_id=$4 AND ($5::uuid IS NULL OR p.workspace_id=$5) FOR UPDATE`, [runId,operationId,input.missionId,input.objectiveId,workspaceId(principal),input.agentSessionId]);
      if (!context.rowCount) throw new NotFoundException("Protected recovery not found");
      if (!['acquisition_unresolved','recovery_window','secure_assistance'].includes(context.rows[0]!.state)) throw new ConflictException({ code: "PROTECTED_RECOVERY_NOT_ACTIVE", state: context.rows[0]!.state });
      await client.query(`UPDATE protected_transactions SET lifecycle_state=CASE WHEN $3='request_secure_assistance' THEN 'secure_assistance' ELSE lifecycle_state END,recovery_resolution=jsonb_build_object('action',$3,'correctedScope',$4::jsonb,'reason',$5,'requestedAt',now()),updated_at=now() WHERE run_id=$1 AND operation_id=$2`, [runId,operationId,input.action,JSON.stringify(input.correctedScope ?? null),input.reason]);
      await client.query(`INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata,technical) VALUES($1,$2,$3,'decision',$4,$5::jsonb,true)`, [input.missionId,input.objectiveId,input.agentSessionId,`Protected acquisition recovery: ${input.action}`,JSON.stringify({runId,operationId,action:input.action})]);
      return { runId, operationId, action: input.action, accepted: true };
    });
  }
  async recoveryState(principal: Principal, runId: string, operationId: string) {
    const result=await this.database.query(`SELECT pt.operation_id AS "operationId",pt.lifecycle_state AS state,pt.recovery_expires_at AS "recoveryExpiresAt",pt.reason_code AS "reasonCode",pt.credential_security_status AS "credentialSecurityStatus",pt.recovery_resolution->>'action' AS "pendingAction" FROM protected_transactions pt JOIN runs r ON r.id=pt.run_id JOIN projects p ON p.id=r.project_id WHERE pt.run_id=$1 AND pt.operation_id=$2 AND ($3::uuid IS NULL OR p.workspace_id=$3)`,[runId,operationId,workspaceId(principal)]);
    if(!result.rowCount) throw new NotFoundException("Protected transaction not found"); return result.rows[0];
  }
}
function workspaceId(principal: Principal) { return principal.kind === "user" ? principal.workspaceId : null; }
