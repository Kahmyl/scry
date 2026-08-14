import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  CreateCredentialInput,
  CreateEnvironmentInput,
  CreateProjectInput,
  GetOperatingContextInput,
  ListCredentialsInput,
  OperatingContext,
  UpdateCredentialInput,
  UpdateEnvironmentInput,
  ValidateCredentialReferencesInput,
} from "@scry/contracts";
import {
  agentDecisionBoundarySchema,
  executionPolicySchema,
  missionResumePointerSchema,
  operatingContextSchema,
} from "@scry/contracts";

import type { Principal } from "../../auth/index.js";
import { Database } from "../../infrastructure/index.js";
import { encryptCredential } from "../credential.crypto.js";

export class ProjectConfigurationRepository {
  constructor(private readonly database: Database) {}

  async createProject(principal: Principal, input: CreateProjectInput) {
    this.requireWriteAccess(principal);
    const workspaceId = await this.workspaceFor(principal);
    const result = await this.database.query(
      `INSERT INTO projects(workspace_id, name, description) VALUES ($1, $2, $3)
       RETURNING id, name, description, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [workspaceId, input.name, input.description],
    );
    return result.rows[0]!;
  }

  async listProjects(principal: Principal) {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    return (
      await this.database.query(
        `SELECT id, name, description, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM projects
         WHERE ($1::uuid IS NULL OR workspace_id = $1)
         ORDER BY created_at DESC`,
        [workspaceId],
      )
    ).rows;
  }

  async operatingContext(
    principal: Principal,
    input: GetOperatingContextInput,
  ): Promise<OperatingContext> {
    return this.database.transaction(async (query) => {
      await query.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
      const projects = await query.query<{ id: string; name: string; description: string }>(
      `SELECT id,name,description FROM projects
       WHERE ($1::uuid IS NULL OR workspace_id=$1)
         AND ($2::uuid IS NULL OR id=$2)
       ORDER BY created_at DESC LIMIT 6`,
      [workspaceId, input.projectId ?? null],
    );
    const projectCount = projects.rowCount ?? projects.rows.length;
    if (input.projectId && projectCount === 0) {
      throw new NotFoundException({ code: "PROJECT_NOT_FOUND" });
    }
    const selected = input.projectId
      ? projects.rows[0]
      : projectCount === 1 ? projects.rows[0] : undefined;
    const projectCandidates = projects.rows.slice(0, 5);
    const empty: OperatingContext = {
      selection: {
        project: null,
        requiresProjectSelection: projectCount > 1,
        projectCandidates: { items: projectCandidates, truncated: projectCount > 5 },
      },
      missions: { candidates: { items: [], truncated: false } },
      credentials: { items: [], truncated: false },
      environments: { items: [], truncated: false },
      authoring: {
        reusable: { items: [], truncated: false }, ready: false,
        recoverable: { items: [], truncated: false },
        missing: ["project", "mission", "objective", "environment", "flow_draft", "authoring_session"],
      },
      continuation: {
        deterministicPreparationAvailable: false,
        userAuthorityRequired: projectCount > 1,
        safeActions: projectCount > 1 ? ["get_operating_context_with_project"] : ["create_project_in_dashboard"],
        blockerCode: projectCount > 1 ? "PROJECT_SELECTION_REQUIRED" : "NO_PROJECT",
      },
    };
    if (!selected) return operatingContextSchema.parse(empty);

      const requiredCredentialReferences = input.requiredCredentialReferences;
      const [missions, credentials, environments, authoring] = await Promise.all([
        query.query<{ id: string; title: string; status: "planning" | "running" | "blocked" | "awaiting_user"; revision: number; currentObjectiveId: string | null; resumePointer: unknown }>(
          `SELECT id,title,status,revision,current_objective_id AS "currentObjectiveId",
                  resume_pointer AS "resumePointer"
           FROM missions WHERE project_id=$1
             AND status IN ('planning','running','blocked','awaiting_user')
             AND ($2::uuid IS NULL OR id=$2)
           ORDER BY updated_at DESC LIMIT 6`, [selected.id, input.missionId ?? null]),
        query.query<{ referenceId: string; name: string; securityStatus: "active" | "compromised" | "revoked";
          eligibleForAuthorization: boolean; authorizedEnvironmentIds: string[];
          authorizedEnvironmentIdsTruncated: boolean; createdAt: Date | string; updatedAt: Date | string }>(
          `SELECT credential.id AS "referenceId",credential.name,
                  credential.security_status AS "securityStatus",
                  (credential.security_status='active') AS "eligibleForAuthorization",
                  ARRAY(SELECT environment.id::text FROM environments environment
                    WHERE environment.project_id=credential.project_id
                      AND environment.secret_refs ? credential.id::text
                    ORDER BY environment.created_at LIMIT 20) AS "authorizedEnvironmentIds",
                  ((SELECT count(*) FROM environments environment
                    WHERE environment.project_id=credential.project_id
                      AND environment.secret_refs ? credential.id::text) > 20)
                    AS "authorizedEnvironmentIdsTruncated",
                  credential.created_at AS "createdAt",credential.updated_at AS "updatedAt"
           FROM project_credentials credential
           WHERE credential.project_id=$1 AND credential.deleted_at IS NULL
           ORDER BY credential.name,credential.created_at LIMIT 21`, [selected.id]),
        query.query<{ id: string; name: string; baseOrigin: string; secretRefs: string[]; policy: Record<string, unknown>;
          executionReadiness: "runtime_required" | "runtime_admitted" | "recovery_required" }>(
          `SELECT environment.id,environment.name,environment.base_origin AS "baseOrigin",
                  environment.secret_refs AS "secretRefs",environment.policy,
                  CASE
                    WHEN EXISTS (
                      SELECT 1 FROM adaptive_sessions session
                      WHERE session.environment_id=environment.id AND session.state='active'
                        AND session.decision_boundary->>'type'='environment_unavailable'
                    ) THEN 'recovery_required'
                    WHEN EXISTS (
                      SELECT 1 FROM adaptive_sessions session
                      WHERE session.environment_id=environment.id AND session.state='active'
                    ) THEN 'runtime_admitted'
                    ELSE 'runtime_required'
                  END AS "executionReadiness"
           FROM environments environment WHERE environment.project_id=$1
           ORDER BY (
             ($2::text IS NULL OR environment.base_origin=$2 OR environment.policy->'allowedOrigins' ? $2)
             AND (environment.secret_refs @> $3::jsonb)
           ) DESC,environment.created_at LIMIT 11`,
          [selected.id, input.requiredOrigin ?? null, JSON.stringify(requiredCredentialReferences)]),
        query.query<{ sessionId: string; missionId: string; objectiveId: string; flowDraftId: string;
          environmentId: string; state: "active"; decisionBoundary: unknown; turnId: string | null;
          turnState: string | null; operationId: string | null; mutationOutcome: string | null;
          operationObjectiveId: string | null; operationFlowDraftId: string | null;
          _categoryRank: number }>(
          `SELECT * FROM (SELECT s.id AS "sessionId",s.mission_id AS "missionId",
                  s.active_objective_id AS "objectiveId",s.active_flow_draft_id AS "flowDraftId",
                  s.environment_id AS "environmentId",s.state,
                  s.decision_boundary AS "decisionBoundary",
                  turn.id AS "turnId",turn.state AS "turnState",
                  operation.operation_id AS "operationId",operation.mutation_outcome AS "mutationOutcome",
                  operation.objective_id AS "operationObjectiveId",operation.flow_draft_id AS "operationFlowDraftId",
                  row_number() OVER (
                    PARTITION BY (s.decision_boundary ? 'authoringRecovery')
                    ORDER BY s.updated_at DESC
                  ) AS "_categoryRank"
           FROM adaptive_sessions s
           JOIN missions m ON m.id=s.mission_id AND m.status IN ('planning','running')
           JOIN mission_objectives o ON o.id=s.active_objective_id AND o.status IN ('pending','running')
           JOIN agent_sessions a ON a.id=s.agent_session_id AND a.status='active'
           JOIN flow_drafts d ON d.id=s.active_flow_draft_id AND d.state='editing'
           LEFT JOIN LATERAL (
             SELECT id,state FROM mission_authoring_turns
             WHERE session_id=s.id ORDER BY updated_at DESC LIMIT 1
           ) turn ON true
           LEFT JOIN LATERAL (
             SELECT operation_id,mutation_outcome,objective_id,flow_draft_id FROM adaptive_operations
             WHERE session_id=s.id ORDER BY sequence DESC LIMIT 1
           ) operation ON true
           WHERE s.project_id=$1 AND s.state='active'
             AND ($2::uuid IS NULL OR s.mission_id=$2)
             AND NOT EXISTS (SELECT 1 FROM adaptive_operations operation WHERE operation.session_id=s.id
               AND (operation.state='running' OR (operation.mutation_outcome='unknown' AND adaptive_operation_unknown_unresolved(operation.session_id,operation.operation_id))))
           ) ranked WHERE "_categoryRank"<=6
           ORDER BY ("decisionBoundary" ? 'authoringRecovery') DESC,"_categoryRank"`, [selected.id, input.missionId ?? null]),
      ]);
      const snapshot = { missions, credentials, environments, authoring };
    const missionItems = snapshot.missions.rows.slice(0, 5).map((mission) => ({
      ...mission,
      resumePointer: projectOperatingResumePointer(mission.resumePointer),
    }));
    if (input.missionId && missionItems.length === 0)
      throw new NotFoundException({ code: "MISSION_NOT_FOUND" });
    const selectedMissionId = input.missionId
      ? missionItems[0]!.id
      : missionItems.length === 1 ? missionItems[0]?.id : undefined;
    const environmentItems = snapshot.environments.rows.slice(0, 10).map((environment) => {
      const allowedOrigins = Array.isArray(environment.policy.allowedOrigins)
        ? environment.policy.allowedOrigins.filter((value): value is string => typeof value === "string") : [];
      const originCompatible = !input.requiredOrigin || environment.baseOrigin === input.requiredOrigin
        || allowedOrigins.includes(input.requiredOrigin);
      const credentialsCompatible = requiredCredentialReferences.every((reference) =>
        environment.secretRefs.includes(reference));
      return {
        id: environment.id, name: environment.name, baseOrigin: environment.baseOrigin,
        resourceExists: true as const,
        policyValid: allowedOrigins.length > 0 && allowedOrigins.includes(environment.baseOrigin),
        executionReadiness: environment.executionReadiness,
        compatible: originCompatible && credentialsCompatible,
        incompatibilities: [
          ...(!originCompatible ? ["origin_not_allowed" as const] : []),
          ...(!credentialsCompatible ? ["credential_not_authorized" as const] : []),
        ],
        credentialReferenceIds: environment.secretRefs.slice(0, 20),
      };
    });
    const credentialItems = snapshot.credentials.rows.slice(0, 20).map((credential) => ({
      ...credential,
      createdAt: credential.createdAt instanceof Date
        ? credential.createdAt.toISOString() : credential.createdAt,
      updatedAt: credential.updatedAt instanceof Date
        ? credential.updatedAt.toISOString() : credential.updatedAt,
    }));
    const compatibleEnvironmentIds = new Set(environmentItems
      .filter(({ compatible }) => compatible).map(({ id }) => id));
    const reusableCandidates = snapshot.authoring.rows
      .filter(({ decisionBoundary }) => {
        const parsed = agentDecisionBoundarySchema.safeParse(decisionBoundary);
        return decisionBoundary === null || (parsed.success && parsed.data.type === "objective_completed");
      });
    const reusable = reusableCandidates
      .slice(0, 5)
      .map(({ decisionBoundary: _decisionBoundary, turnId: _turnId, turnState: _turnState,
        operationId: _operationId, mutationOutcome: _mutationOutcome,
        operationObjectiveId: _operationObjectiveId, operationFlowDraftId: _operationFlowDraftId,
        _categoryRank,
        ...session }) => session);
    const recoverableCandidates = snapshot.authoring.rows.flatMap((session) => {
      const parsed = agentDecisionBoundarySchema.safeParse(session.decisionBoundary);
      const boundary = parsed.success ? parsed.data : undefined;
      const recovery = boundary?.authoringRecovery;
      return recovery && boundary?.type === "environment_unavailable"
        && recovery.sessionId === session.sessionId && recovery.missionId === session.missionId
        && recovery.objectiveId === session.objectiveId && recovery.flowDraftId === session.flowDraftId
        && recovery.environmentId === session.environmentId
        && recovery.sourceTurnId === session.turnId && session.turnState === "decision_required"
        && recovery.failedOperationId === session.operationId && session.mutationOutcome === "not_applied"
        && session.operationObjectiveId === session.objectiveId
        && session.operationFlowDraftId === session.flowDraftId ? [{ session, recovery }] : [];
    });
    const compatibleRecoverableCandidates = recoverableCandidates.filter(({ session }) =>
      session.missionId === selectedMissionId && compatibleEnvironmentIds.has(session.environmentId));
    const recoverable = compatibleRecoverableCandidates
      .slice(0, 5)
      .map(({ session, recovery }) => ({
        sessionId: recovery.sessionId, missionId: recovery.missionId,
        objectiveId: recovery.objectiveId, flowDraftId: recovery.flowDraftId,
        environmentId: recovery.environmentId, turnId: recovery.sourceTurnId!,
        turnState: "decision_required" as const, mutationOutcome: "not_applied" as const,
        recoveryTool: "advance_flow_authoring" as const, recoveryKind: "intents" as const,
        requiresPendingTurn: false as const,
        recoveryBinding: recovery,
      }));
    const compatibleReusable = reusable.filter(({ missionId, environmentId }) =>
      missionId === selectedMissionId && compatibleEnvironmentIds.has(environmentId));
    const compatibleEnvironment = environmentItems.some(({ compatible }) => compatible);
    const missing: OperatingContext["authoring"]["missing"] = [];
    if (!selectedMissionId) missing.push("mission");
    if (!missionItems.some(({ id, currentObjectiveId }) => id === selectedMissionId && currentObjectiveId)) missing.push("objective");
    if (!compatibleEnvironment) missing.push("environment");
    if (compatibleReusable.length === 0) missing.push("flow_draft", "authoring_session");
    const requirementBlocked = Boolean(input.requiredOrigin || requiredCredentialReferences.length) && !compatibleEnvironment;
      return operatingContextSchema.parse({
      selection: {
        project: { id: selected.id, name: selected.name }, requiresProjectSelection: false,
        projectCandidates: { items: projectCandidates, truncated: projectCount > 5 },
      },
      missions: {
        ...(selectedMissionId ? { selectedMissionId } : {}),
        candidates: { items: missionItems, truncated: (snapshot.missions.rowCount ?? snapshot.missions.rows.length) > 5 },
      },
      credentials: { items: credentialItems, truncated: (snapshot.credentials.rowCount ?? snapshot.credentials.rows.length) > 20 },
      environments: { items: environmentItems, truncated: (snapshot.environments.rowCount ?? snapshot.environments.rows.length) > 10 },
      authoring: {
        reusable: { items: compatibleReusable, truncated: reusableCandidates.length > 5 },
        recoverable: { items: recoverable, truncated: compatibleRecoverableCandidates.length > 5 },
        ready: compatibleReusable.length > 0 && missing.length === 0, missing,
      },
      continuation: {
        deterministicPreparationAvailable: recoverable.length > 0 || compatibleReusable.length > 0
          || (missionItems.length === 0 && compatibleEnvironment),
        userAuthorityRequired: !selectedMissionId && missionItems.length > 1,
        safeActions: recoverable.length > 0
          ? ["get_flow_authoring", "advance_flow_authoring"]
          : missing.length === 0
          ? ["advance_flow_authoring"]
          : !selectedMissionId && missionItems.length > 1
            ? ["get_operating_context_with_mission"]
            : requirementBlocked
              ? ["create_test_environment_or_authorize_credentials"]
              : missionItems.length === 0
                ? ["prepare_flow_authoring"]
                : ["resume_or_start_distinct_mission"],
        ...(!selectedMissionId && missionItems.length > 1
          ? { blockerCode: "MISSION_SELECTION_REQUIRED" as const }
          : requirementBlocked ? { blockerCode: "REQUIREMENTS_UNSATISFIED" as const } : {}),
      },
      });
    });
  }

  async listEnvironments(principal: Principal, projectId: string) {
    await this.requireProject(principal, projectId);
    return (
      await this.database.query(
        `SELECT id, project_id AS "projectId", name, base_origin AS "baseOrigin",
                policy, secret_refs AS "secretRefs", created_at AS "createdAt"
         FROM environments WHERE project_id = $1 ORDER BY created_at`,
        [projectId],
      )
    ).rows;
  }

  async listCredentials(principal: Principal, projectId: string) {
    await this.requireProject(principal, projectId);
    return (await this.database.query(
      `SELECT id,project_id AS "projectId",name,security_status AS "securityStatus",
              created_at AS "createdAt",updated_at AS "updatedAt"
       FROM project_credentials WHERE project_id=$1 AND deleted_at IS NULL
       ORDER BY name,created_at`, [projectId])).rows;
  }

  async listCredentialCandidates(principal: Principal, projectId: string,
    input: ListCredentialsInput = {}) {
    await this.requireProject(principal, projectId);
    const result = await this.database.query(
      `SELECT credential.id,credential.id AS "referenceId",
              credential.project_id AS "projectId",credential.name,
              credential.security_status AS "securityStatus",
              (credential.security_status='active') AS "eligibleForAuthorization",
              ARRAY(SELECT environment.id::text FROM environments environment
                WHERE environment.project_id=credential.project_id
                  AND environment.secret_refs ? credential.id::text
                ORDER BY environment.created_at LIMIT 20) AS "authorizedEnvironmentIds",
              ((SELECT count(*) FROM environments environment
                WHERE environment.project_id=credential.project_id
                  AND environment.secret_refs ? credential.id::text) > 20)
                AS "authorizedEnvironmentIdsTruncated",
              credential.created_at AS "createdAt",credential.updated_at AS "updatedAt"
       FROM project_credentials credential
       WHERE credential.project_id=$1 AND credential.deleted_at IS NULL
         AND ($2::uuid IS NULL OR credential.id=$2)
       ORDER BY credential.name,credential.created_at LIMIT 101`,
      [projectId,input.referenceId ?? null],
    );
    return { items: result.rows.slice(0, 100), truncated: result.rows.length > 100 };
  }

  async listCredentialIncidents(principal: Principal, projectId: string) {
    await this.requireProject(principal, projectId);
    return (
      await this.database.query(
        `SELECT id, run_id AS "runId", credential_id AS "credentialId", operation_id AS "operationId",
              adapter_id AS "adapterId", state, reason_code AS "reasonCode", safe_diagnostics AS "safeDiagnostics",
              created_at AS "createdAt", resolved_at AS "resolvedAt"
       FROM credential_incidents WHERE project_id = $1 ORDER BY created_at DESC`,
        [projectId],
      )
    ).rows;
  }

  async createCredential(principal: Principal, projectId: string, input: CreateCredentialInput) {
    this.requireWriteAccess(principal);
    await this.requireProject(principal, projectId);
    const provenanceValues = [input.missionId, input.objectiveId, input.agentSessionId];
    const hasProvenance = provenanceValues.every((value) => value !== undefined);
    if (!hasProvenance && provenanceValues.some((value) => value !== undefined))
      throw new BadRequestException({ code: "MISSION_CONTEXT_INCOMPLETE" });
    const encrypted = encryptCredential(input.value);
    try {
      return await this.database.transaction(async (client) => {
        if (hasProvenance) {
          const context = await client.query(
            `SELECT 1 FROM missions m JOIN mission_objectives o ON o.mission_id=m.id AND o.id=$3
             JOIN agent_sessions s ON s.mission_id=m.id AND s.id=$4 AND s.status='active'
             WHERE m.id=$2 AND m.project_id=$1`,
            [projectId,input.missionId,input.objectiveId,input.agentSessionId],
          );
          if (!context.rowCount)
            throw new BadRequestException({ code: "MISSION_CONTEXT_INVALID" });
        }
        const result = await client.query(
          `INSERT INTO project_credentials(project_id,name,ciphertext,initialization_vector,authentication_tag,origin_mission_id,origin_objective_id,created_by_agent_session_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id, project_id AS "projectId", name,
                     security_status AS "securityStatus",true AS "eligibleForAuthorization",
                     ARRAY[]::text[] AS "authorizedEnvironmentIds",
                     false AS "authorizedEnvironmentIdsTruncated",
                     created_at AS "createdAt", updated_at AS "updatedAt"`,
          [projectId,input.name,encrypted.ciphertext,encrypted.initializationVector,
            encrypted.authenticationTag,input.missionId ?? null,input.objectiveId ?? null,
            input.agentSessionId ?? null],
        );
        if (hasProvenance)
          await client.query(
          `INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata) VALUES($1,$2,$3,'credential_created',$4,$5::jsonb)`,
          [input.missionId,input.objectiveId,input.agentSessionId,
            `Credential created: ${input.name}`,
            JSON.stringify({ credentialId: result.rows[0]!.id })],
          );
        return result.rows[0]!;
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw new ConflictException({
          code: "CREDENTIAL_NAME_CONFLICT",
          message:
            "An active credential with this name already exists. Existing credentials cannot be overwritten.",
        });
      }
      throw error;
    }
  }

  async updateCredential(principal: Principal, credentialId: string, input: UpdateCredentialInput) {
    this.requireWriteAccess(principal);
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const encrypted = encryptCredential(input.value);
    const result = await this.database.query(
      `WITH updated AS (
         UPDATE project_credentials credential
         SET name=$2,ciphertext=$3,initialization_vector=$4,
             authentication_tag=$5,updated_at=now()
         FROM projects project
         WHERE credential.id=$1 AND credential.deleted_at IS NULL
           AND project.id=credential.project_id
           AND ($6::uuid IS NULL OR project.workspace_id=$6)
         RETURNING credential.*
       ) SELECT updated.id,updated.id AS "referenceId",updated.project_id AS "projectId",
                updated.name,updated.security_status AS "securityStatus",
                (updated.security_status='active') AS "eligibleForAuthorization",
                ARRAY(SELECT environment.id::text FROM environments environment
                  WHERE environment.project_id=updated.project_id
                    AND environment.secret_refs ? updated.id::text
                  ORDER BY environment.created_at LIMIT 20) AS "authorizedEnvironmentIds",
                ((SELECT count(*) FROM environments environment
                  WHERE environment.project_id=updated.project_id
                    AND environment.secret_refs ? updated.id::text) > 20)
                  AS "authorizedEnvironmentIdsTruncated",
                updated.created_at AS "createdAt",updated.updated_at AS "updatedAt"
         FROM updated`,
      [
        credentialId,
        input.name,
        encrypted.ciphertext,
        encrypted.initializationVector,
        encrypted.authenticationTag,
        workspaceId,
      ],
    );
    if (!result.rowCount) throw new NotFoundException("Credential not found");
    return result.rows[0]!;
  }

  async deleteCredential(principal: Principal, credentialId: string) {
    this.requireWriteAccess(principal);
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const result = await this.database.query(
      `UPDATE project_credentials credential
       SET deleted_at = now(), updated_at = now()
       FROM projects project
       WHERE credential.id = $1 AND credential.deleted_at IS NULL
         AND project.id = credential.project_id
         AND ($2::uuid IS NULL OR project.workspace_id = $2)
       RETURNING credential.id`,
      [credentialId, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Credential not found");
    return { id: credentialId, deleted: true };
  }

  async createEnvironment(principal: Principal, projectId: string, input: CreateEnvironmentInput) {
    this.requireWriteAccess(principal);
    await this.requireProject(principal, projectId);
    await this.requireMissionCommandContext(
      projectId,
      input.missionId,
      input.objectiveId,
      input.agentSessionId,
    );
    await this.requireActiveCredentials(
      (text, values) => this.database.query<{ id: string }>(text, values),
      projectId,
      input.secretRefs,
    );
    const result = await this.database.query(
      `INSERT INTO environments(project_id, name, base_origin, policy, secret_refs)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       RETURNING id, project_id AS "projectId", name, base_origin AS "baseOrigin",
                 policy, secret_refs AS "secretRefs", created_at AS "createdAt"`,
      [
        projectId,
        input.name,
        input.baseOrigin,
        JSON.stringify(input.policy),
        JSON.stringify(input.secretRefs),
      ],
    );
    return result.rows[0]!;
  }

  async validateCredentialReferences(
    principal: Principal,
    environmentId: string,
    input: ValidateCredentialReferencesInput,
  ) {
    await this.requireProject(principal, input.projectId);
    const environment = await this.database.query<{ secretRefs: string[] }>(
      `SELECT secret_refs AS "secretRefs" FROM environments
       WHERE id = $1 AND project_id = $2`,
      [environmentId, input.projectId],
    );
    if (!environment.rowCount) throw new NotFoundException("Environment not found");
    const allowed = new Set(environment.rows[0]!.secretRefs);
    const unavailable = input.secretRefs.find((reference) => !allowed.has(reference));
    if (unavailable) {
      return {
        valid: false,
        errors: [
          {
            code: "CREDENTIAL_NOT_AUTHORIZED",
            message: `Protected credential "${unavailable}" is not authorized in the selected environment.`,
          },
        ],
      };
    }
    const active = await this.database.query<{ id: string }>(
      `SELECT id::text FROM project_credentials
       WHERE project_id = $1 AND deleted_at IS NULL AND security_status='active'
         AND id = ANY($2::uuid[])`,
      [input.projectId, input.secretRefs],
    );
    const activeIds = new Set(active.rows.map(({ id }) => String(id)));
    const missing = input.secretRefs.find((reference) => !activeIds.has(reference));
    if (missing)
      return {
        valid: false,
        errors: [
          {
            code: "CREDENTIAL_UNAVAILABLE",
            message: `Protected credential "${missing}" is invalid or unavailable for this project.`,
          },
        ],
      };
    return { valid: true };
  }

  async updateEnvironment(
    principal: Principal,
    environmentId: string,
    input: UpdateEnvironmentInput,
  ) {
    this.requireWriteAccess(principal);
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const environment = await this.database.query<{ projectId: string; policy: unknown }>(
      `SELECT environment.project_id AS "projectId",environment.policy
       FROM environments environment
       JOIN projects project ON project.id = environment.project_id
       WHERE environment.id = $1
         AND ($2::uuid IS NULL OR project.workspace_id = $2)`,
      [environmentId, workspaceId],
    );
    if (!environment.rowCount) throw new NotFoundException("Flow environment not found");
    await this.requireMissionCommandContext(
      environment.rows[0]!.projectId,
      input.missionId,
      input.objectiveId,
      input.agentSessionId,
    );
    await this.requireActiveCredentials(
      (text, values) => this.database.query<{ id: string }>(text, values),
      environment.rows[0]!.projectId,
      input.secretRefs,
    );
    const currentPolicy = executionPolicySchema.parse(environment.rows[0]!.policy);
    const policy = executionPolicySchema.parse({
      ...input.policy,
      externalResourcePresentationAuthorities:
        currentPolicy.externalResourcePresentationAuthorities ?? [],
      protectedSyntheticInputs: currentPolicy.protectedSyntheticInputs,
    });
    const result = await this.database.query(
      `UPDATE environments environment
       SET base_origin = $2, policy = $3::jsonb, secret_refs = $4::jsonb
       FROM projects p
       WHERE environment.id = $1 AND p.id = environment.project_id
         AND ($5::uuid IS NULL OR p.workspace_id = $5)
       RETURNING environment.id, environment.project_id AS "projectId",
                 environment.name, environment.base_origin AS "baseOrigin",
                 environment.policy, environment.secret_refs AS "secretRefs",
                 environment.created_at AS "createdAt"`,
      [
        environmentId,
        input.baseOrigin,
        JSON.stringify(policy),
        JSON.stringify(input.secretRefs),
        workspaceId,
      ],
    );
    if (!result.rowCount) throw new NotFoundException("Flow environment not found");
    return result.rows[0]!;
  }

  private async workspaceFor(principal: Principal) {
    if (principal.kind === "user") return principal.workspaceId;
    const serviceWorkspace = await this.database.query(
      "SELECT id FROM workspaces WHERE slug = 'scry-service'",
    );
    if (!serviceWorkspace.rowCount) throw new Error("Service workspace is missing");
    return serviceWorkspace.rows[0]!.id as string;
  }

  private async requireMissionCommandContext(
    projectId: string,
    missionId: string,
    objectiveId: string,
    agentSessionId: string,
  ) {
    const result = await this.database.query(
      `SELECT 1 FROM missions m JOIN mission_objectives o ON o.mission_id=m.id AND o.id=$3 JOIN agent_sessions s ON s.mission_id=m.id AND s.id=$4 AND s.status='active' WHERE m.project_id=$1 AND m.id=$2`,
      [projectId, missionId, objectiveId, agentSessionId],
    );
    if (!result.rowCount) throw new BadRequestException({ code: "MISSION_CONTEXT_INVALID" });
  }

  private async requireActiveCredentials(
    query: (text: string, values: unknown[]) => Promise<{ rows: Array<{ id: string }> }>,
    projectId: string,
    references: string[],
  ) {
    if (!references.length) return;
    const malformed = references.find(
      (reference) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          reference,
        ),
    );
    if (malformed)
      throw new BadRequestException(
        `Protected credential reference "${malformed}" is invalid or unavailable for this Flow.`,
      );
    const result = await query(
      `SELECT id::text FROM project_credentials WHERE project_id = $1
         AND deleted_at IS NULL AND security_status='active' AND id = ANY($2::uuid[])`,
      [projectId, references],
    );
    const active = new Set(result.rows.map((row) => String(row.id)));
    const missing = references.find((reference) => !active.has(reference));
    if (missing)
      throw new BadRequestException(
        `Protected credential "${missing}" is invalid or unavailable for this project.`,
      );
  }

  private async requireProject(principal: Principal, projectId: string) {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const result = await this.database.query(
      `SELECT 1 FROM projects WHERE id = $1 AND ($2::uuid IS NULL OR workspace_id = $2)`,
      [projectId, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Project not found");
  }

  private requireWriteAccess(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer")
      throw new ForbiddenException("Workspace viewers have read-only access");
  }
}

function projectOperatingResumePointer(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pointer = value as Record<string, unknown>;
  const external = pointer.externalInput && typeof pointer.externalInput === "object"
    && !Array.isArray(pointer.externalInput)
    ? pointer.externalInput as Record<string, unknown> : undefined;
  const authority = external?.authority && typeof external.authority === "object"
    && !Array.isArray(external.authority) ? external.authority as Record<string, unknown> : undefined;
  const continuation = external?.continuation && typeof external.continuation === "object"
    && !Array.isArray(external.continuation) ? external.continuation as Record<string, unknown> : undefined;
  const fulfillmentPaths = Array.isArray(external?.fulfillmentPaths)
    ? external.fulfillmentPaths.slice(0, 10)
    : [];
  const projected = {
    objectiveId: pointer.objectiveId,
    recommendedAction: pointer.recommendedAction,
    ...(typeof pointer.flowId === "string" ? { flowId: pointer.flowId } : {}),
    ...(typeof pointer.revisionId === "string" ? { revisionId: pointer.revisionId } : {}),
    ...(typeof pointer.runId === "string" ? { runId: pointer.runId } : {}),
    ...(typeof pointer.explanation === "string" ? { explanation: pointer.explanation.slice(0, 2_000) } : {}),
    ...(external ? { externalInput: {
      condition: external.condition,
      ...(typeof external.cause === "string" ? { cause: external.cause.slice(0, 2_000) } : {}),
      ...(typeof external.affectedOperation === "string" ? { affectedOperation: external.affectedOperation.slice(0, 500) } : {}),
      ...(typeof external.affectedResource === "string" ? { affectedResource: external.affectedResource.slice(0, 500) } : {}),
      effectState: external.effectState,
      authority: {
        required: authority?.required, type: authority?.type,
        ...(typeof authority?.reason === "string" ? { reason: authority.reason.slice(0, 2_000) } : {}),
      },
      availableCapabilities: Array.isArray(external.availableCapabilities) ? external.availableCapabilities.slice(0, 20) : [],
      fulfillmentPaths,
      constraints: Array.isArray(external.constraints) ? external.constraints.slice(0, 50) : [],
      consequences: Array.isArray(external.consequences) ? external.consequences.slice(0, 50) : [],
      continuation: {
        retryCurrentOperation: continuation?.retryCurrentOperation,
        freshObservationRequired: continuation?.freshObservationRequired,
        newOperationRequired: continuation?.newOperationRequired,
        newDraftRequired: continuation?.newDraftRequired,
        newSessionRequired: continuation?.newSessionRequired,
      },
      waiting: external.waiting, terminal: external.terminal,
      lifecycle: {
        terminal: false, taskStillActive: true, sameMissionResumable: true,
        sameObjectiveResumable: true, shouldFinalize: false,
        shouldPublishFinalReport: false, shouldCreateReplacementMission: false,
        requiredNextStep: "fulfill_human_prerequisite_then_resume",
      },
      resumeRef: external.resumeRef,
    } } : {}),
  };
  const parsed = missionResumePointerSchema.safeParse(projected);
  return parsed.success ? parsed.data : null;
}

function isPostgresUniqueViolation(error: unknown): error is { code: "23505" } {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
