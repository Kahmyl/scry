import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type {
  CompileFlowDraftInput,
  CreateAuthenticationContractInput,
  CreateFlowDraftInput,
  PublishFlowDraftInput,
  StartProbeSessionInput,
  UpdateFlowDraftInput,
} from "@scry/contracts";
import { browserObservationRuntimeHealth } from "@scry/praxis";

import type { Principal } from "./auth.types.js";
import { Database } from "./database.js";
import { ReleaseAdmissionService } from "./release-admission.service.js";

type Query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rowCount: number | null; rows: T[] }>;

@Injectable()
export class AuthoringService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
  ) {}

  async createDraft(principal: Principal, input: CreateFlowDraftInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.db.transaction(async (client) => {
      const q = bind(client);
      await this.requireContext(
        q,
        principal,
        input.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.environmentId,
      );
      const replay = await q<{ id: string; version: number; state: string }>(
        `SELECT d.id,d.version,d.state FROM flow_drafts d JOIN flow_draft_events e ON e.draft_id=d.id WHERE d.project_id=$1 AND e.safe_metadata->>'idempotencyKey'=$2 LIMIT 1`,
        [input.projectId, input.idempotencyKey],
      );
      if (replay.rowCount) return { ...replay.rows[0], replayed: true };
      const id = randomUUID();
      await q(
        `INSERT INTO flow_drafts(id,project_id,mission_id,objective_id,environment_id,flow_id,name,description,content,state,version,plan,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'editing',1,$10::jsonb,$11)`,
        [
          id,
          input.projectId,
          input.missionId,
          input.objectiveId,
          input.environmentId,
          input.flowId ?? null,
          input.name,
          input.description,
          JSON.stringify(input.content),
          JSON.stringify(input.plan),
          input.agentSessionId,
        ],
      );
      await this.event(q, id, 1, "created", input.agentSessionId, "Flow draft created", {
        idempotencyKey: input.idempotencyKey,
      });
      await this.activity(q, input, "Flow draft created", { draftId: id });
      return { id, version: 1, state: "editing", replayed: false };
    });
  }

  async updateDraft(principal: Principal, draftId: string, input: UpdateFlowDraftInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        d.environmentId,
      );
      if (d.version !== input.expectedVersion)
        throw new ConflictException({
          code: "FLOW_DRAFT_VERSION_CONFLICT",
          actualVersion: d.version,
        });
      if (["published", "abandoned"].includes(d.state))
        throw new ConflictException({ code: "FLOW_DRAFT_IMMUTABLE", state: d.state });
      const updated = await q<{ version: number; state: string }>(
        `UPDATE flow_drafts SET name=COALESCE($2,name),description=COALESCE($3,description),content=COALESCE($4::jsonb,content),plan=COALESCE($5::jsonb,plan),version=version+1,state='editing',updated_at=now() WHERE id=$1 RETURNING version,state`,
        [
          draftId,
          input.name ?? null,
          input.description ?? null,
          input.content ? JSON.stringify(input.content) : null,
          input.plan ? JSON.stringify(input.plan) : null,
        ],
      );
      await q(
        `UPDATE flow_compilations SET status='stale',invalidated_at=now() WHERE draft_id=$1 AND status IN ('pending','execution_ready','calibration_required')`,
        [draftId],
      );
      await this.event(
        q,
        draftId,
        updated.rows[0]!.version,
        "updated",
        input.agentSessionId,
        input.reason,
        {},
      );
      return { id: draftId, ...updated.rows[0] };
    });
  }

  async getDraft(principal: Principal, draftId: string) {
    const d = await this.requireDraft((t, v) => this.db.query(t, v), principal, draftId, false);
    const [events, probes, compilations] = await Promise.all([
      this.db.query(
        `SELECT version,type,summary,safe_metadata AS "safeMetadata",occurred_at AS "occurredAt" FROM flow_draft_events WHERE draft_id=$1 ORDER BY id`,
        [draftId],
      ),
      this.db.query(
        `SELECT id,draft_version AS "draftVersion",level,state,result,failure_provenance AS "failureProvenance",reason_code AS "reasonCode",created_at AS "createdAt",completed_at AS "completedAt" FROM probe_sessions WHERE draft_id=$1 ORDER BY created_at DESC`,
        [draftId],
      ),
      this.db.query(
        `SELECT id,draft_version AS "draftVersion",flow_revision_id AS "flowRevisionId",status,diagnostics,compiled_contract_digest AS "compiledContractDigest",created_at AS "createdAt" FROM flow_compilations WHERE draft_id=$1 ORDER BY created_at DESC`,
        [draftId],
      ),
    ]);
    return { ...d, events: events.rows, probes: probes.rows, compilations: compilations.rows };
  }

  async listDrafts(principal: Principal, missionId: string) {
    await this.requireMission((t, v) => this.db.query(t, v), principal, missionId);
    return (
      await this.db.query(
        `SELECT id,project_id AS "projectId",mission_id AS "missionId",objective_id AS "objectiveId",environment_id AS "environmentId",flow_id AS "flowId",name,description,state,version,published_revision_id AS "publishedRevisionId",updated_at AS "updatedAt" FROM flow_drafts WHERE mission_id=$1 ORDER BY updated_at DESC`,
        [missionId],
      )
    ).rows;
  }

  async abandonDraft(
    principal: Principal,
    draftId: string,
    input: {
      missionId: string;
      objectiveId: string;
      agentSessionId: string;
      expectedVersion: number;
      reason: string;
    },
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        d.environmentId,
      );
      if (d.version !== input.expectedVersion)
        throw new ConflictException({
          code: "FLOW_DRAFT_VERSION_CONFLICT",
          actualVersion: d.version,
        });
      if (d.state === "published")
        throw new ConflictException({ code: "PUBLISHED_DRAFT_CANNOT_BE_ABANDONED" });
      const result = await q<{ version: number; state: string }>(
        `UPDATE flow_drafts SET state='abandoned',version=version+1,updated_at=now() WHERE id=$1 RETURNING version,state`,
        [draftId],
      );
      await q(
        `UPDATE flow_compilations SET status='superseded',invalidated_at=now() WHERE draft_id=$1 AND status NOT IN ('superseded','stale')`,
        [draftId],
      );
      await this.event(
        q,
        draftId,
        result.rows[0]!.version,
        "abandoned",
        input.agentSessionId,
        input.reason,
        {},
      );
      return { id: draftId, ...result.rows[0] };
    });
  }

  async getProbe(principal: Principal, probeId: string) {
    const result = await this.db.query(
      `SELECT p.id,p.draft_id AS "draftId",p.mission_id AS "missionId",p.objective_id AS "objectiveId",p.draft_version AS "draftVersion",p.level,p.state,p.result,p.failure_provenance AS "failureProvenance",p.reason_code AS "reasonCode",p.created_at AS "createdAt",p.started_at AS "startedAt",p.completed_at AS "completedAt" FROM probe_sessions p JOIN missions m ON m.id=p.mission_id JOIN projects project ON project.id=m.project_id WHERE p.id=$1 AND ($2::uuid IS NULL OR project.workspace_id=$2)`,
      [probeId, workspace(principal)],
    );
    if (!result.rowCount) throw new NotFoundException("Probe Session not found");
    return result.rows[0];
  }

  async startProbe(principal: Principal, draftId: string, input: StartProbeSessionInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.environmentId,
      );
      if (d.version !== input.draftVersion)
        throw new ConflictException({ code: "STALE_DRAFT_VERSION", actualVersion: d.version });
      if (input.level === "calibration_transaction") {
        const auth = await q(
          `SELECT 1 FROM mission_authorizations WHERE id=$1 AND mission_id=$2 AND objective_id=$3 AND environment_id=$4 AND kind='authentication_calibration' AND status='approved' AND (expires_at IS NULL OR expires_at>now())`,
          [input.authorizationId, input.missionId, input.objectiveId, input.environmentId],
        );
        if (!auth.rowCount) throw new ConflictException({ code: "PROBE_AUTHORIZATION_REQUIRED" });
      }
      const existing = await q<{ id: string; state: string }>(
        `SELECT id,state FROM probe_sessions WHERE draft_id=$1 AND idempotency_key=$2`,
        [draftId, input.idempotencyKey],
      );
      if (existing.rowCount) return { ...existing.rows[0], replayed: true };
      if (input.authenticationContractRevisionId) {
        const contract = await q(
          `SELECT 1 FROM authentication_contract_revisions r JOIN authentication_contracts c ON c.id=r.contract_id WHERE r.id=$1 AND c.project_id=$2 AND c.environment_id=$3 AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at>now())`,
          [input.authenticationContractRevisionId, d.projectId, input.environmentId],
        );
        if (!contract.rowCount)
          throw new ConflictException({ code: "AUTHENTICATION_CONTRACT_INVALID" });
      }
      const id = randomUUID();
      await q(
        `INSERT INTO probe_sessions(id,draft_id,mission_id,objective_id,environment_id,draft_version,level,authorization_id,disposable_data_confirmed,authentication_contract_revision_id,created_by_agent_session_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          draftId,
          input.missionId,
          input.objectiveId,
          input.environmentId,
          input.draftVersion,
          input.level,
          input.authorizationId ?? null,
          input.disposableDataConfirmed,
          input.authenticationContractRevisionId ?? null,
          input.agentSessionId,
          input.idempotencyKey,
        ],
      );
      await q(`UPDATE flow_drafts SET state='probing',updated_at=now() WHERE id=$1`, [draftId]);
      await q(
        `INSERT INTO probe_outbox(probe_session_id,release_id,schema_fingerprint) VALUES($1,$2,$3)`,
        [id, releaseId(), schemaFingerprint()],
      );
      await this.event(
        q,
        draftId,
        d.version,
        "probe_started",
        input.agentSessionId,
        "Probe Session queued",
        { probeSessionId: id, level: input.level },
      );
      return { id, state: "queued", replayed: false };
    });
  }

  async cancelProbe(
    principal: Principal,
    probeId: string,
    missionId: string,
    agentSessionId: string,
  ) {
    this.requireWrite(principal);
    const result = await this.db.query(
      `UPDATE probe_sessions p SET cancellation_requested_at=now(),state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,completed_at=CASE WHEN state='queued' THEN now() ELSE completed_at END FROM missions m,agent_sessions s WHERE p.id=$1 AND p.mission_id=$2 AND m.id=p.mission_id AND s.id=$3 AND s.mission_id=p.mission_id AND ($4::uuid IS NULL OR m.project_id IN (SELECT project_id FROM projects WHERE workspace_id=$4)) RETURNING p.id,p.state`,
      [probeId, missionId, agentSessionId, workspace(principal)],
    );
    if (!result.rowCount) throw new NotFoundException("Probe Session not found");
    return result.rows[0];
  }

  async compile(principal: Principal, draftId: string, input: CompileFlowDraftInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.environmentId,
      );
      if (d.version !== input.draftVersion)
        throw new ConflictException({ code: "STALE_DRAFT_VERSION", actualVersion: d.version });
      const runtime = browserObservationRuntimeHealth();
      const probe = input.probeSessionId
        ? await q<{ state: string; result: any }>(
            `SELECT state,result FROM probe_sessions WHERE id=$1 AND draft_id=$2 AND draft_version=$3`,
            [input.probeSessionId, draftId, d.version],
          )
        : { rowCount: 0, rows: [] };
      const diagnostics: any[] = [];
      if (!runtime.healthy) diagnostics.push(...runtime.diagnostics);
      if (!probe.rowCount)
        diagnostics.push({
          code: "PROBE_REQUIRED",
          message: "Compile from a completed Probe Session.",
        });
      else if (probe.rows[0]!.state !== "completed")
        diagnostics.push({ code: "PROBE_INCOMPLETE", message: "Probe Session is not complete." });
      else diagnostics.push(...(probe.rows[0]!.result?.diagnostics ?? []));
      const status = !runtime.healthy
        ? "runtime_unhealthy"
        : diagnostics.length
          ? "calibration_required"
          : "execution_ready";
      const planDigest = hash(d.plan);
      const authorizationDigest = await stateDigest(
        q,
        `SELECT id,kind,status,expires_at FROM mission_authorizations WHERE mission_id=$1 AND objective_id=$2 ORDER BY id`,
        [input.missionId, input.objectiveId],
      );
      const calibrationDigest = await stateDigest(
        q,
        `SELECT c.id,a.id AS attestation_id FROM calibration_contracts c LEFT JOIN calibration_contract_revisions r ON r.contract_id=c.id LEFT JOIN calibration_attestations a ON a.contract_revision_id=r.id WHERE c.project_id=$1 ORDER BY c.id,a.id`,
        [d.projectId],
      );
      const contract = {
        planDigest,
        targetContracts: probe.rows[0]?.result?.targets ?? [],
        readinessContracts: probe.rows[0]?.result?.readiness ?? [],
        runtimeHash: runtime.runtimeHash,
        capabilityManifestHash: runtime.capabilityManifestHash,
        authorizationDigest,
        calibrationDigest,
      };
      const digest = hash(contract);
      const id = randomUUID();
      await q(
        `UPDATE flow_compilations SET status='superseded',invalidated_at=now() WHERE draft_id=$1 AND draft_version=$2 AND status IN ('execution_ready','calibration_required')`,
        [draftId, d.version],
      );
      await q(
        `INSERT INTO flow_compilations(id,draft_id,draft_version,project_id,mission_id,objective_id,environment_id,probe_session_id,authentication_contract_revision_id,status,plan_digest,compiled_contract_digest,capability_manifest_hash,runtime_hash,page_fingerprint,authentication_fingerprint,target_contracts,readiness_contracts,diagnostics,authorization_digest,calibration_digest,created_by_agent_session_id,idempotency_key,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20,$21,$22,$23,now())`,
        [
          id,
          draftId,
          d.version,
          d.projectId,
          input.missionId,
          input.objectiveId,
          input.environmentId,
          input.probeSessionId ?? null,
          input.authenticationContractRevisionId ?? null,
          status,
          planDigest,
          digest,
          runtime.capabilityManifestHash,
          runtime.runtimeHash,
          probe.rows[0]?.result?.pageFingerprint ?? null,
          probe.rows[0]?.result?.authenticationFingerprint ?? null,
          JSON.stringify(contract.targetContracts),
          JSON.stringify(contract.readinessContracts),
          JSON.stringify(diagnostics),
          authorizationDigest,
          calibrationDigest,
          input.agentSessionId,
          input.idempotencyKey,
        ],
      );
      await q(`UPDATE flow_drafts SET state=$2,updated_at=now() WHERE id=$1`, [
        draftId,
        status === "execution_ready" ? "publishable" : "editing",
      ]);
      await this.event(
        q,
        draftId,
        d.version,
        "compilation_completed",
        input.agentSessionId,
        `Compilation ${status}`,
        { compilationId: id, status },
      );
      return { id, status, diagnostics, compiledContractDigest: digest };
    });
  }

  async publish(principal: Principal, draftId: string, input: PublishFlowDraftInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        d.environmentId,
      );
      if (d.version !== input.expectedVersion)
        throw new ConflictException({ code: "STALE_DRAFT_VERSION", actualVersion: d.version });
      const c = await q<{ id: string; status: string; draftVersion: number; planDigest: string }>(
        `SELECT id,status,draft_version AS "draftVersion",plan_digest AS "planDigest" FROM flow_compilations WHERE id=$1 AND draft_id=$2 FOR UPDATE`,
        [input.compilationId, draftId],
      );
      if (
        !c.rowCount ||
        c.rows[0]!.status !== "execution_ready" ||
        c.rows[0]!.draftVersion !== d.version ||
        c.rows[0]!.planDigest !== hash(d.plan)
      )
        throw new ConflictException({ code: "EXECUTION_READY_COMPILATION_REQUIRED" });
      const flowId = d.flowId ?? randomUUID();
      const revisionId = randomUUID();
      let revision = 1;
      if (d.flowId) {
        const current = await q<{ revision: number }>(
          `SELECT fr.revision FROM flows f JOIN flow_revisions fr ON fr.id=f.latest_revision_id WHERE f.id=$1 AND f.project_id=$2 FOR UPDATE`,
          [d.flowId, d.projectId],
        );
        if (!current.rowCount) throw new NotFoundException("Flow not found");
        revision = current.rows[0]!.revision + 1;
      } else
        await q(
          `INSERT INTO flows(id,project_id,name,description,latest_revision_id,visibility,purpose,origin_mission_id,origin_objective_id,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            flowId,
            d.projectId,
            d.name,
            d.description,
            revisionId,
            input.visibility,
            input.purpose,
            input.missionId,
            input.objectiveId,
            input.agentSessionId,
          ],
        );
      await q(
        `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)`,
        [
          revisionId,
          flowId,
          revision,
          JSON.stringify(d.content),
          JSON.stringify(d.plan),
          JSON.stringify({ valid: true, compiled: true, compilationId: input.compilationId }),
          input.agentSessionId,
          input.reason,
        ],
      );
      if (d.flowId)
        await q(
          `UPDATE flows SET latest_revision_id=$2,name=$3,description=$4,updated_at=now() WHERE id=$1`,
          [flowId, revisionId, d.name, d.description],
        );
      else
        await q(
          `INSERT INTO mission_flow_links(mission_id,objective_id,flow_id,visibility,purpose,reason,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.missionId,
            input.objectiveId,
            flowId,
            input.visibility,
            input.purpose,
            input.reason,
            input.agentSessionId,
          ],
        );
      await q(`UPDATE flow_compilations SET flow_revision_id=$2 WHERE id=$1`, [
        input.compilationId,
        revisionId,
      ]);
      await q(
        `UPDATE flow_drafts SET flow_id=$2,state='published',published_revision_id=$3,updated_at=now() WHERE id=$1`,
        [draftId, flowId, revisionId],
      );
      await this.event(
        q,
        draftId,
        d.version,
        "published",
        input.agentSessionId,
        `Published Flow revision ${revision}`,
        { flowId, revisionId, compilationId: input.compilationId },
      );
      return { flowId, revisionId, revision, compilationId: input.compilationId };
    });
  }

  async createAuthenticationContract(
    principal: Principal,
    input: CreateAuthenticationContractInput,
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.db.transaction(async (client) => {
      const q = bind(client);
      await this.requireContext(
        q,
        principal,
        input.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.environmentId,
      );
      if (input.selectedMethodIndex >= input.submissionMethods.length)
        throw new ConflictException({ code: "AUTH_SUBMISSION_METHOD_INVALID" });
      const contractId = randomUUID(),
        revisionId = randomUUID();
      const payload = {
        entryUrl: input.entryUrl,
        usernameTarget: input.usernameTarget,
        passwordTarget: input.passwordTarget,
        submissionMethods: input.submissionMethods,
        selectedMethodIndex: input.selectedMethodIndex,
        success: input.success,
        failureSignals: input.failureSignals,
        sessionReuse: input.sessionReuse,
      };
      await q(
        `INSERT INTO authentication_contracts(id,project_id,environment_id,application_origin,name,latest_revision_id) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          contractId,
          input.projectId,
          input.environmentId,
          input.applicationOrigin,
          input.name,
          revisionId,
        ],
      );
      await q(
        `INSERT INTO authentication_contract_revisions(id,contract_id,revision,contract,created_by_agent_session_id,expires_at) VALUES($1,$2,1,$3::jsonb,$4,$5)`,
        [
          revisionId,
          contractId,
          JSON.stringify(payload),
          input.agentSessionId,
          input.expiresAt ?? null,
        ],
      );
      return { contractId, revisionId, revision: 1 };
    });
  }

  async listAuthenticationContracts(principal: Principal, projectId: string) {
    return (
      await this.db.query(
        `SELECT c.id,c.project_id AS "projectId",c.environment_id AS "environmentId",c.application_origin AS "applicationOrigin",c.name,c.latest_revision_id AS "latestRevisionId",r.revision,r.structural_fingerprint AS "structuralFingerprint",r.expires_at AS "expiresAt",r.revoked_at AS "revokedAt" FROM authentication_contracts c JOIN authentication_contract_revisions r ON r.id=c.latest_revision_id JOIN projects p ON p.id=c.project_id WHERE c.project_id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2) ORDER BY c.updated_at DESC`,
        [projectId, workspace(principal)],
      )
    ).rows;
  }

  async listSessionLeases(principal: Principal, projectId: string) {
    return (
      await this.db.query(
        `SELECT l.id,l.project_id AS "projectId",l.environment_id AS "environmentId",l.authentication_contract_revision_id AS "authenticationContractRevisionId",l.origin,l.runtime_hash AS "runtimeHash",l.structural_fingerprint AS "structuralFingerprint",l.state,l.expires_at AS "expiresAt",l.last_validated_at AS "lastValidatedAt",l.created_at AS "createdAt" FROM authenticated_session_leases l JOIN projects p ON p.id=l.project_id WHERE l.project_id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2) ORDER BY l.created_at DESC`,
        [projectId, workspace(principal)],
      )
    ).rows;
  }

  async revokeSessionLease(principal: Principal, leaseId: string) {
    this.requireWrite(principal);
    const result = await this.db.query(
      `UPDATE authenticated_session_leases l SET state='revoked',revoked_at=now() FROM projects p WHERE l.id=$1 AND p.id=l.project_id AND ($2::uuid IS NULL OR p.workspace_id=$2) RETURNING l.id,l.state,l.revoked_at AS "revokedAt"`,
      [leaseId, workspace(principal)],
    );
    if (!result.rowCount) throw new NotFoundException("Authenticated session lease not found");
    return result.rows[0];
  }

  private requireWrite(p: Principal) {
    if (p.kind === "user" && p.role === "viewer")
      throw new ForbiddenException("Write access required");
  }
  private async requireContext(
    q: Query,
    p: Principal,
    projectId: string,
    missionId: string,
    objectiveId: string,
    sessionId: string,
    environmentId: string,
  ) {
    const r = await q(
      `SELECT 1 FROM missions m JOIN mission_objectives o ON o.mission_id=m.id JOIN agent_sessions s ON s.mission_id=m.id JOIN environments e ON e.project_id=m.project_id WHERE m.id=$1 AND m.project_id=$2 AND o.id=$3 AND s.id=$4 AND s.status='active' AND e.id=$5 AND ($6::uuid IS NULL OR m.project_id IN(SELECT id FROM projects WHERE workspace_id=$6))`,
      [missionId, projectId, objectiveId, sessionId, environmentId, workspace(p)],
    );
    if (!r.rowCount) throw new ConflictException({ code: "AUTHORING_CONTEXT_MISMATCH" });
  }
  private async requireDraft(q: Query, p: Principal, id: string, lock: boolean) {
    const r = await q<any>(
      `SELECT d.id,d.project_id AS "projectId",d.mission_id AS "missionId",d.objective_id AS "objectiveId",d.environment_id AS "environmentId",d.flow_id AS "flowId",d.name,d.description,d.content,d.plan,d.state,d.version FROM flow_drafts d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)${lock ? " FOR UPDATE" : ""}`,
      [id, workspace(p)],
    );
    if (!r.rowCount) throw new NotFoundException("Flow draft not found");
    return r.rows[0];
  }
  private async requireMission(q: Query, p: Principal, id: string) {
    const r = await q(
      `SELECT 1 FROM missions m JOIN projects p ON p.id=m.project_id WHERE m.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [id, workspace(p)],
    );
    if (!r.rowCount) throw new NotFoundException("Mission not found");
  }
  private event(
    q: Query,
    id: string,
    version: number,
    type: string,
    session: string,
    summary: string,
    meta: any,
  ) {
    return q(
      `INSERT INTO flow_draft_events(draft_id,version,type,agent_session_id,summary,safe_metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [id, version, type, session, summary, JSON.stringify(meta)],
    );
  }
  private activity(
    q: Query,
    input: { missionId: string; objectiveId: string; agentSessionId: string },
    summary: string,
    meta: any,
  ) {
    return q(
      `INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata,technical) VALUES($1,$2,$3,'authoring',$4,$5::jsonb,true)`,
      [input.missionId, input.objectiveId, input.agentSessionId, summary, JSON.stringify(meta)],
    );
  }
}

function bind(c: PoolClient): Query {
  return (t, v) => c.query(t, v);
}
function workspace(p: Principal) {
  return p.kind === "user" ? p.workspaceId : null;
}
function hash(v: unknown) {
  return createHash("sha256").update(stable(v)).digest("hex");
}
function stable(v: any): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
async function stateDigest(q: Query, sql: string, values: unknown[]) {
  return hash((await q(sql, values)).rows);
}
function releaseId() {
  return process.env.SCRY_RELEASE_ID ?? "development";
}
function schemaFingerprint() {
  return process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline";
}
