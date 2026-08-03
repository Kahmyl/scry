import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type {
  CancelCalibrationInput,
  CurrentPlan,
  DecideCalibrationInput,
  RequestCalibrationInput,
  RetryCalibrationInput,
} from "@scry/contracts";
import {
  protectedTransactionDigest,
  transactionInputDigest,
  transactionInputSchemaDigest,
} from "@scry/executor";

import type { Principal } from "../auth/index.js";
import { Database } from "../infrastructure/index.js";
import { ReleaseAdmissionService } from "../runtime/index.js";

@Injectable()
export class CalibrationService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
  ) {}

  async request(principal: Principal, projectId: string, input: RequestCalibrationInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const context = await client.query(
        `SELECT 1 FROM missions m JOIN mission_objectives o ON o.mission_id=m.id AND o.id=$3 JOIN agent_sessions s ON s.mission_id=m.id AND s.id=$4 AND s.status='active' WHERE m.project_id=$1 AND m.id=$2`,
        [projectId, input.missionId, input.objectiveId, input.agentSessionId],
      );
      if (!context.rowCount) throw new ConflictException({ code: "MISSION_CONTEXT_INVALID" });
      const requestHash = digest(input);
      const scope = `calibration:request:${projectId}`;
      await client.query(
        `INSERT INTO idempotency_records(scope,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [scope, input.idempotencyKey, requestHash],
      );
      const replay = await client.query<{
        requestHash: string;
        response?: Record<string, unknown>;
      }>(
        `SELECT request_hash AS "requestHash",response FROM idempotency_records WHERE scope=$1 AND key=$2 FOR UPDATE`,
        [scope, input.idempotencyKey],
      );
      if (replay.rows[0]!.requestHash !== requestHash)
        throw new ConflictException({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "The idempotency key was already used with different calibration input.",
        });
      if (replay.rows[0]!.response) return { ...replay.rows[0]!.response, replayed: true };

      const source = await client.query<{ plan: CurrentPlan; projectName: string }>(
        `SELECT revision.plan, project.name AS "projectName"
         FROM flow_revisions revision JOIN flows flow ON flow.id=revision.flow_id
         JOIN projects project ON project.id=flow.project_id
         JOIN environments environment ON environment.id=$3 AND environment.project_id=project.id
         WHERE revision.id=$1 AND project.id=$2 AND ($4::uuid IS NULL OR project.workspace_id=$4)`,
        [input.sourceFlowRevisionId, projectId, input.environmentId, workspaceId(principal)],
      );
      if (!source.rowCount) throw new NotFoundException("Flow revision or environment not found");
      const matches = source.rows[0]!.plan.steps.filter(
        (step) =>
          step.action.type === "protectedTransaction" &&
          step.action.operationId === input.operationId,
      );
      if (matches.length !== 1 || matches[0]!.action.type !== "protectedTransaction") {
        throw new ConflictException({
          code: matches.length
            ? "CALIBRATION_OPERATION_AMBIGUOUS"
            : "CALIBRATION_OPERATION_MISMATCH",
          message: "The source revision must contain exactly one matching protected operation.",
        });
      }
      const step = matches[0]!;
      if (step.action.type !== "protectedTransaction")
        throw new ConflictException({
          code: "CALIBRATION_OPERATION_MISMATCH",
          message: "The selected step is not protected.",
        });
      const targetIndex = source.rows[0]!.plan.steps.findIndex(
        (candidate) => candidate.id === step.id,
      );
      const unsafePrefix = source.rows[0]!.plan.steps.slice(0, targetIndex).find(
        (candidate) => candidate.action.type === "protectedTransaction",
      );
      if (unsafePrefix)
        throw new ConflictException({
          code: "CALIBRATION_UNSAFE_PREFIX",
          message: "A calibration may not execute another protected operation before its target.",
          stepId: unsafePrefix.id,
        });
      const operationDigest = protectedTransactionDigest(
        step.action,
        source.rows[0]!.plan.allowedOrigins,
      );
      const inputSchemaDigest = transactionInputSchemaDigest(step.action);
      const inputDigest = transactionInputDigest(step.action);
      const existingEffective = await client.query(
        `SELECT attestation.id AS "attestationId"
         FROM calibration_attestations attestation
         JOIN calibration_contract_revisions revision ON revision.id=attestation.contract_revision_id
         JOIN calibration_contracts contract ON contract.id=revision.contract_id
         JOIN calibration_decisions decision ON decision.attestation_id=attestation.id AND decision.decision='approved'
         LEFT JOIN calibration_revocations revocation ON revocation.attestation_id=attestation.id
         WHERE contract.project_id=$1 AND revision.environment_id=$2 AND revision.operation_digest=$3
           AND revision.input_schema_digest=$4 AND revocation.id IS NULL
         ORDER BY attestation.created_at DESC LIMIT 1`,
        [projectId, input.environmentId, operationDigest, inputSchemaDigest],
      );
      if (existingEffective.rowCount) {
        const response = {
          state: "attested",
          attestationId: existingEffective.rows[0]!.attestationId,
          operationDigest,
          replayed: false,
          safeActions: ["bind_to_flow"],
        };
        await client.query(
          `UPDATE idempotency_records SET response=$3::jsonb,completed_at=now() WHERE scope=$1 AND key=$2`,
          [scope, input.idempotencyKey, JSON.stringify(response)],
        );
        return response;
      }

      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `calibration-contract:${projectId}:${input.name}`,
      ]);
      const aggregate = await client.query<{
        id: string;
        latestRevisionId: string;
        revision: number;
      }>(
        `SELECT contract.id, contract.latest_revision_id AS "latestRevisionId", revision.revision
         FROM calibration_contracts contract JOIN calibration_contract_revisions revision ON revision.id=contract.latest_revision_id
         WHERE contract.project_id=$1 AND contract.name=$2 FOR UPDATE OF contract`,
        [projectId, input.name],
      );
      const contractId = aggregate.rows[0]?.id ?? randomUUID();
      const revisionId = randomUUID();
      const revision = (aggregate.rows[0]?.revision ?? 0) + 1;
      if (!aggregate.rowCount) {
        await client.query(
          `INSERT INTO calibration_contracts(id,project_id,mission_id,objective_id,agent_session_id,name,latest_revision_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            contractId,
            projectId,
            input.missionId,
            input.objectiveId,
            input.agentSessionId,
            input.name,
            revisionId,
            userId(principal),
          ],
        );
      }
      await client.query(
        `INSERT INTO calibration_contract_revisions(id,contract_id,revision,source_flow_revision_id,source_step_id,operation_id,operation_digest,input_schema_digest,input_digest,operation_snapshot,environment_id,allowed_origins,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13)`,
        [
          revisionId,
          contractId,
          revision,
          input.sourceFlowRevisionId,
          step.id,
          input.operationId,
          operationDigest,
          inputSchemaDigest,
          inputDigest,
          JSON.stringify(step.action),
          input.environmentId,
          JSON.stringify(source.rows[0]!.plan.allowedOrigins),
          userId(principal),
        ],
      );
      if (aggregate.rowCount)
        await client.query(`UPDATE calibration_contracts SET latest_revision_id=$2 WHERE id=$1`, [
          contractId,
          revisionId,
        ]);
      const session = await client.query<{ id: string }>(
        `INSERT INTO calibration_sessions(project_id,mission_id,objective_id,agent_session_id,contract_revision_id,idempotency_key,request_hash,state,disposable_data_confirmed,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'queued',true,now()+interval '24 hours') RETURNING id`,
        [
          projectId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          revisionId,
          input.idempotencyKey,
          requestHash,
        ],
      );
      await client.query(
        `INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata,technical) VALUES($1,$2,$3,'calibration','Calibration queued',$4::jsonb,true)`,
        [
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          JSON.stringify({ calibrationId: contractId, sessionId: session.rows[0]!.id }),
        ],
      );
      await client.query(
        `INSERT INTO calibration_events(session_id,sequence,type,phase,code,safe_payload) VALUES($1,1,'session.created','requested','CALIBRATION_REQUESTED',$2::jsonb)`,
        [
          session.rows[0]!.id,
          JSON.stringify({ operationId: input.operationId, purpose: "WITHHELD" }),
        ],
      );
      await client.query(
        `INSERT INTO calibration_outbox(calibration_session_id,release_id,schema_fingerprint) VALUES($1,$2,$3)`,
        [session.rows[0]!.id, releaseId(), schemaFingerprint()],
      );
      const response = {
        calibrationId: contractId,
        contractRevisionId: revisionId,
        sessionId: session.rows[0]!.id,
        state: "queued",
        operationDigest,
        replayed: false,
        safeActions: ["inspect", "cancel"],
      };
      await client.query(
        `UPDATE idempotency_records SET response=$3::jsonb,completed_at=now() WHERE scope=$1 AND key=$2`,
        [scope, input.idempotencyKey, JSON.stringify(response)],
      );
      return response;
    });
  }

  async list(principal: Principal, projectId: string) {
    await this.requireProject(principal, projectId);
    return (
      await this.database.query(
        `SELECT contract.id,contract.mission_id AS "missionId",contract.objective_id AS "objectiveId",contract.name,contract.latest_revision_id AS "latestRevisionId",revision.revision,revision.operation_id AS "operationId",
              revision.operation_digest AS "operationDigest",session.id AS "sessionId",session.state AS "sessionState",
              attempt.safe_diagnostics AS "safeDiagnostics",attestation.id AS "attestationId",
              COALESCE(decision.decision,'draft') AS status,revision.created_at AS "createdAt"
       FROM calibration_contracts contract JOIN calibration_contract_revisions revision ON revision.id=contract.latest_revision_id
       LEFT JOIN LATERAL (SELECT * FROM calibration_sessions WHERE contract_revision_id=revision.id ORDER BY created_at DESC LIMIT 1) session ON true
       LEFT JOIN calibration_attempts attempt ON attempt.id=session.current_attempt_id
       LEFT JOIN calibration_attestations attestation ON attestation.contract_revision_id=revision.id
       LEFT JOIN calibration_decisions decision ON decision.attestation_id=attestation.id
       WHERE contract.project_id=$1 ORDER BY contract.created_at DESC`,
        [projectId],
      )
    ).rows;
  }

  async get(principal: Principal, calibrationId: string) {
    const result = await this.database.query(
      `SELECT contract.id,contract.project_id AS "projectId",contract.name,contract.latest_revision_id AS "latestRevisionId",
        COALESCE(json_agg(json_build_object('id',revision.id,'revision',revision.revision,'operationId',revision.operation_id,
          'operationDigest',revision.operation_digest,'sessionId',session.id,'sessionState',session.state,
          'attemptDiagnostics',attempt.safe_diagnostics,'attestationId',attestation.id,'boundaryFingerprint',attestation.boundary_fingerprint,
          'status',COALESCE(decision.decision,'draft'),'revoked',revocation.id IS NOT NULL,'createdAt',revision.created_at)
          ORDER BY revision.revision DESC),'[]'::json) AS revisions
       FROM calibration_contracts contract JOIN projects project ON project.id=contract.project_id
       JOIN calibration_contract_revisions revision ON revision.contract_id=contract.id
       LEFT JOIN LATERAL (SELECT * FROM calibration_sessions WHERE contract_revision_id=revision.id ORDER BY created_at DESC LIMIT 1) session ON true
       LEFT JOIN calibration_attempts attempt ON attempt.id=session.current_attempt_id
       LEFT JOIN calibration_attestations attestation ON attestation.contract_revision_id=revision.id
       LEFT JOIN calibration_decisions decision ON decision.attestation_id=attestation.id
       LEFT JOIN calibration_revocations revocation ON revocation.attestation_id=attestation.id
       WHERE contract.id=$1 AND ($2::uuid IS NULL OR project.workspace_id=$2) GROUP BY contract.id`,
      [calibrationId, workspaceId(principal)],
    );
    if (!result.rowCount) throw new NotFoundException("Calibration not found");
    const calibration = result.rows[0] as {
      revisions: Array<{
        attestationId?: string;
        status: string;
        revoked: boolean;
        sessionState?: string;
      }>;
    };
    const latest = calibration.revisions[0];
    const safeActions = calibrationSafeActions(latest, principal);
    return { ...result.rows[0], safeActions };
  }

  async decide(
    principal: Principal,
    calibrationId: string,
    attestationId: string,
    decision: "approved" | "rejected",
    input: DecideCalibrationInput,
  ) {
    if (principal.kind !== "user" || !["owner", "admin"].includes(principal.role))
      throw new ForbiddenException("Calibration approval requires an owner or admin");
    return this.database.transaction(async (client) => {
      const attestation = await client.query(
        `SELECT attestation.id FROM calibration_attestations attestation
         JOIN calibration_contract_revisions revision ON revision.id=attestation.contract_revision_id
         JOIN calibration_contracts contract ON contract.id=revision.contract_id JOIN projects project ON project.id=contract.project_id
         JOIN agent_sessions session ON session.id=$6 AND session.mission_id=contract.mission_id AND session.status='active'
         WHERE contract.id=$1 AND attestation.id=$2 AND project.workspace_id=$3 AND contract.mission_id=$4 AND contract.objective_id=$5
           AND attestation.privacy_verified AND attestation.canary_scan_passed AND attestation.mutation_count=1`,
        [
          calibrationId,
          attestationId,
          principal.workspaceId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
        ],
      );
      if (!attestation.rowCount)
        throw new ConflictException({
          code: "CALIBRATION_ATTESTATION_REQUIRED",
          message: "An exact successful privacy attestation is required.",
        });
      try {
        await client.query(
          `INSERT INTO calibration_decisions(attestation_id,decision,actor_id,reason_code) VALUES($1,$2,$3,$4)`,
          [attestationId, decision, principal.userId, input.reasonCode ?? null],
        );
      } catch {
        throw new ConflictException({
          code: "CALIBRATION_ALREADY_DECIDED",
          message: "This immutable attestation already has a decision.",
        });
      }
      await client.query(
        `INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata) VALUES($1,$2,$3,'decision',$4,$5::jsonb)`,
        [
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          `Calibration ${decision}`,
          JSON.stringify({ calibrationId, attestationId }),
        ],
      );
      return { calibrationId, attestationId, status: decision };
    });
  }

  async retry(principal: Principal, sessionId: string, input: RetryCalibrationInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const context = await client.query(
        `SELECT 1 FROM calibration_sessions c JOIN agent_sessions s ON s.id=$4 AND s.mission_id=c.mission_id AND s.status='active' WHERE c.id=$1 AND c.mission_id=$2 AND c.objective_id=$3`,
        [sessionId, input.missionId, input.objectiveId, input.agentSessionId],
      );
      if (!context.rowCount) throw new ConflictException({ code: "MISSION_CONTEXT_INVALID" });
      const scope = `calibration:retry:${sessionId}`;
      const requestHash = digest(input);
      await client.query(
        `INSERT INTO idempotency_records(scope,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [scope, input.idempotencyKey, requestHash],
      );
      const record = await client.query<{
        requestHash: string;
        response?: Record<string, unknown>;
      }>(
        `SELECT request_hash AS "requestHash",response FROM idempotency_records WHERE scope=$1 AND key=$2 FOR UPDATE`,
        [scope, input.idempotencyKey],
      );
      if (record.rows[0]!.requestHash !== requestHash)
        throw new ConflictException({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "The retry idempotency key was used with different input.",
        });
      if (record.rows[0]!.response) return { ...record.rows[0]!.response, replayed: true };
      const result = await client.query(
        `UPDATE calibration_sessions session SET state='queued',current_attempt_id=NULL,updated_at=now(),completed_at=NULL
         FROM projects project WHERE session.id=$1 AND project.id=session.project_id AND ($2::uuid IS NULL OR project.workspace_id=$2)
           AND session.state IN ('failed','sealed') AND session.expires_at>now() RETURNING session.id`,
        [sessionId, workspaceId(principal)],
      );
      if (!result.rowCount)
        throw new ConflictException({
          code: "CALIBRATION_RETRY_UNAVAILABLE",
          message: "The session cannot be retried safely.",
        });
      await client.query(
        `INSERT INTO calibration_outbox(calibration_session_id,release_id,schema_fingerprint) VALUES($1,$2,$3) ON CONFLICT(calibration_session_id) DO UPDATE SET published_at=NULL,last_error=NULL,release_id=EXCLUDED.release_id,schema_fingerprint=EXCLUDED.schema_fingerprint`,
        [sessionId, releaseId(), schemaFingerprint()],
      );
      const response = {
        sessionId,
        state: "queued",
        replayed: false,
        safeActions: ["inspect", "cancel"],
      };
      await client.query(
        `UPDATE idempotency_records SET response=$3::jsonb,completed_at=now() WHERE scope=$1 AND key=$2`,
        [scope, input.idempotencyKey, JSON.stringify(response)],
      );
      return response;
    });
  }

  async cancel(principal: Principal, sessionId: string, input: CancelCalibrationInput) {
    this.requireWrite(principal);
    const result = await this.database.query(
      `UPDATE calibration_sessions session SET state='cancelled',completed_at=now(),updated_at=now()
       FROM projects project,agent_sessions agent WHERE session.id=$1 AND project.id=session.project_id AND ($2::uuid IS NULL OR project.workspace_id=$2)
         AND session.mission_id=$3 AND session.objective_id=$4 AND agent.id=$5 AND agent.mission_id=session.mission_id AND agent.status='active'
         AND session.state IN ('requested','queued') RETURNING session.id`,
      [sessionId, workspaceId(principal), input.missionId, input.objectiveId, input.agentSessionId],
    );
    if (!result.rowCount)
      throw new ConflictException({
        code: "CALIBRATION_CANCEL_UNAVAILABLE",
        message: "Only an unclaimed session can be cancelled.",
      });
    return { sessionId, state: "cancelled", safeActions: [] };
  }

  private requireWrite(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer")
      throw new ForbiddenException("Viewer access is read-only");
  }
  private async requireProject(principal: Principal, projectId: string) {
    const result = await this.database.query(
      `SELECT 1 FROM projects WHERE id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)`,
      [projectId, workspaceId(principal)],
    );
    if (!result.rowCount) throw new NotFoundException("Project not found");
  }
}

function workspaceId(principal: Principal) {
  return principal.kind === "user" ? principal.workspaceId : null;
}
function userId(principal: Principal) {
  return principal.kind === "user" ? principal.userId : null;
}
function releaseId() {
  return process.env.SCRY_RELEASE_ID ?? "development";
}
function schemaFingerprint() {
  return process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline";
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function calibrationSafeActions(
  latest:
    { attestationId?: string; status: string; revoked: boolean; sessionState?: string } | undefined,
  principal: Principal,
) {
  if (latest?.status === "approved" && latest.attestationId && !latest.revoked)
    return ["bind_to_flow"];
  if (latest?.attestationId && latest.status === "draft")
    return [
      principal.kind === "user" && ["owner", "admin"].includes(principal.role)
        ? "approve_attestation"
        : "request_owner_approval",
      "reject_attestation",
    ];
  if (["requested", "queued"].includes(latest?.sessionState ?? "")) return ["inspect", "cancel"];
  if (
    [
      "claimed",
      "preparing",
      "executing_preflight",
      "boundary_reached",
      "arming_privacy",
      "capsule_bootstrapping",
      "preparation_running",
      "preparation_verified",
      "executing_protected_transaction",
      "verifying_safe_exit",
      "scanning_channels",
    ].includes(latest?.sessionState ?? "")
  )
    return ["inspect"];
  if (["failed", "sealed"].includes(latest?.sessionState ?? ""))
    return ["retry_preflight", "create_new_revision"];
  if (latest?.sessionState === "mutation_outcome_unknown")
    return ["inspect", "manual_cleanup_required", "create_new_revision"];
  return ["create_new_revision"];
}
