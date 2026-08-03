import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  CreateEnvironmentInput,
  CreateCredentialInput,
  CreateProjectInput,
  UpdateEnvironmentInput,
  ValidateCredentialReferencesInput,
  UpdateCredentialInput,
} from "@scry/contracts";

import { Database } from "../../infrastructure/index.js";
import type { Principal } from "../../auth/index.js";
import { encryptCredential } from "../credential.crypto.js";
import { ProjectConfigurationRepository } from "./project-configuration.repository.js";

@Injectable()
export class ScryRepository {
  private readonly configuration: ProjectConfigurationRepository;

  constructor(@Inject(Database) private readonly database: Database) {
    this.configuration = new ProjectConfigurationRepository(database);
  }

  createProject(...args: Parameters<ProjectConfigurationRepository["createProject"]>) {
    return this.configuration.createProject(...args);
  }
  listProjects(...args: Parameters<ProjectConfigurationRepository["listProjects"]>) {
    return this.configuration.listProjects(...args);
  }
  listEnvironments(...args: Parameters<ProjectConfigurationRepository["listEnvironments"]>) {
    return this.configuration.listEnvironments(...args);
  }
  listCredentials(...args: Parameters<ProjectConfigurationRepository["listCredentials"]>) {
    return this.configuration.listCredentials(...args);
  }
  listCredentialIncidents(
    ...args: Parameters<ProjectConfigurationRepository["listCredentialIncidents"]>
  ) {
    return this.configuration.listCredentialIncidents(...args);
  }
  createCredential(...args: Parameters<ProjectConfigurationRepository["createCredential"]>) {
    return this.configuration.createCredential(...args);
  }
  updateCredential(...args: Parameters<ProjectConfigurationRepository["updateCredential"]>) {
    return this.configuration.updateCredential(...args);
  }
  deleteCredential(...args: Parameters<ProjectConfigurationRepository["deleteCredential"]>) {
    return this.configuration.deleteCredential(...args);
  }
  createEnvironment(...args: Parameters<ProjectConfigurationRepository["createEnvironment"]>) {
    return this.configuration.createEnvironment(...args);
  }
  validateCredentialReferences(
    ...args: Parameters<ProjectConfigurationRepository["validateCredentialReferences"]>
  ) {
    return this.configuration.validateCredentialReferences(...args);
  }
  updateEnvironment(...args: Parameters<ProjectConfigurationRepository["updateEnvironment"]>) {
    return this.configuration.updateEnvironment(...args);
  }

  async listRuns(principal: Principal, projectId: string) {
    await this.requireProject(principal, projectId);
    return (
      await this.database.query(
        `SELECT r.id,r.mission_id AS "missionId",r.objective_id AS "objectiveId",m.title AS "missionTitle",l.role,r.state,r.phase,r.outcome_classification AS "outcomeClassification",r.result_classification AS "resultClassification",r.reliability_eligible AS "reliabilityEligible",r.compiled_contract_id AS "compiledContractId",
                r.created_at AS "createdAt", r.updated_at AS "updatedAt",
                r.execution_snapshot AS "executionSnapshot",
                r.environment_snapshot AS "environmentSnapshot",
                r.plan_snapshot->>'name' AS "planName",
                r.rerun_of_run_id AS "rerunOfRunId",
                (r.state IN ('failed','timed_out','infrastructure_error') AND COALESCE(r.result_classification,'')<>'legacy_authoring_attempt') AS "needsAttention",
                COALESCE(a.attempt_count, 0)::int AS "attemptCount"
         FROM runs r JOIN missions m ON m.id=r.mission_id JOIN mission_run_links l ON l.run_id=r.id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS attempt_count FROM attempts WHERE run_id = r.id
         ) a ON true
         WHERE r.project_id = $1 ORDER BY r.created_at DESC`,
        [projectId],
      )
    ).rows;
  }

  async getRun(principal: Principal, runId: string) {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const run = await this.database.query(
      `SELECT runs.id, runs.project_id AS "projectId", runs.environment_id AS "environmentId",
              runs.mission_id AS "missionId",runs.objective_id AS "objectiveId",runs.agent_session_id AS "agentSessionId",
              runs.flow_revision_id AS "flowRevisionId", runs.state, runs.phase,
              runs.outcome_classification AS "outcomeClassification",
              runs.rerun_of_run_id AS "rerunOfRunId",
              (runs.state IN ('failed','timed_out','infrastructure_error')) AS "needsAttention",
              runs.plan_snapshot AS "planSnapshot",
              runs.environment_snapshot AS "environmentSnapshot",
              runs.policy_snapshot AS "policySnapshot",
              runs.veil_policy_snapshot AS "veilPolicySnapshot",
              runs.execution_snapshot AS "executionSnapshot",
              CASE
                WHEN runs.state = 'finalizing' THEN 'finalizing'
                WHEN latest_event.type = 'step.evidence_started' THEN 'capturing_evidence'
                WHEN runs.state = 'running' THEN runs.phase
                ELSE runs.state
              END AS "currentPhase",
              runs.created_at AS "createdAt", runs.updated_at AS "updatedAt"
       FROM runs
       JOIN projects p ON p.id = runs.project_id
       LEFT JOIN LATERAL (
         SELECT events.type
         FROM attempts attempt
         JOIN run_events events ON events.attempt_id = attempt.id
         WHERE attempt.run_id = runs.id
         ORDER BY events.created_at DESC, events.sequence DESC LIMIT 1
       ) latest_event ON true
       WHERE runs.id = $1 AND ($2::uuid IS NULL OR p.workspace_id = $2)`,
      [runId, workspaceId],
    );
    if (!run.rowCount) throw new NotFoundException("Run not found");
    return run.rows[0]!;
  }

  async rerunExact(principal: Principal, runId: string) {
    this.requireWriteAccess(principal);
    const source = await this.validateRunCredentials(principal, runId);
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO runs(project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,state,phase,
           plan_snapshot, environment_snapshot, policy_snapshot, veil_policy_snapshot, execution_snapshot,
           rerun_of_run_id, idempotency_key
         )
         SELECT project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,'queued','queued',
                plan_snapshot, environment_snapshot, policy_snapshot, veil_policy_snapshot, execution_snapshot, id, $2
         FROM runs WHERE id = $1
         RETURNING id, project_id AS "projectId", environment_id AS "environmentId",
                   flow_revision_id AS "flowRevisionId",
                   state, phase, created_at AS "createdAt"`,
        [source.id, `rerun:${source.id}:${randomUUID()}`],
      );
      if (!result.rowCount) throw new NotFoundException("Source run not found");
      const run = result.rows[0]!;
      await client.query(
        `INSERT INTO mission_run_links(run_id,mission_id,objective_id,role,reason,classified_by_agent_session_id)
        SELECT $1,r.mission_id,r.objective_id,'candidate','Exact rerun',r.agent_session_id FROM runs r WHERE r.id=$1`,
        [run.id],
      );
      await client.query(
        `INSERT INTO run_outbox(run_id, release_id, schema_fingerprint) VALUES ($1, $2, $3)`,
        [
          run.id,
          process.env.SCRY_RELEASE_ID ?? "development",
          process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline",
        ],
      );
      return run;
    });
  }

  async validateRunCredentials(principal: Principal, runId: string) {
    const run = await this.getRun(principal, runId);
    const references = this.planSecretRefs(run.planSnapshot);
    const allowed = new Set<string>(run.environmentSnapshot?.secretRefs ?? []);
    const unavailable = references.find((reference) => !allowed.has(reference));
    if (unavailable) {
      throw new BadRequestException(
        `Protected credential "${unavailable}" is not available in this run's Flow environment.`,
      );
    }
    await this.requireActiveCredentials(
      (text, values) => this.database.query<{ id: string }>(text, values),
      run.projectId,
      references,
    );
    return run;
  }

  async getArtifact(principal: Principal, artifactId: string) {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const result = await this.database.query(
      `SELECT a.id, a.kind, a.availability, a.content_type AS "contentType",
              a.storage_key AS "storageKey", a.size_bytes AS "sizeBytes", a.checksum_sha256 AS "checksumSha256", a.metadata AS observation,
              a.privacy_classification AS "privacyClassification", a.failure_provenance AS "failureProvenance",
              a.reason_code AS "reasonCode"
              ,a.destruction_status AS "destructionStatus"
       FROM artifacts a
       JOIN attempts att ON att.id = a.attempt_id
       JOIN runs r ON r.id = att.run_id
       JOIN projects p ON p.id = r.project_id
       WHERE a.id = $1 AND ($2::uuid IS NULL OR p.workspace_id = $2)`,
      [artifactId, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Artifact not found");
    return result.rows[0]!;
  }

  private planSecretRefs(plan: unknown): string[] {
    if (!plan || typeof plan !== "object") return [];
    const steps = (plan as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) return [];
    return [
      ...new Set(
        steps.flatMap((step) => {
          if (!step || typeof step !== "object") return [];
          const action = (step as { action?: unknown }).action;
          if (!action || typeof action !== "object") return [];
          const secretRef = (action as { secretRef?: unknown }).secretRef;
          return typeof secretRef === "string" ? [secretRef] : [];
        }),
      ),
    ];
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
    if (malformed) {
      throw new BadRequestException(
        `Protected credential reference "${malformed}" is invalid or unavailable for this Flow.`,
      );
    }
    const result = await query(
      `SELECT id::text FROM project_credentials
       WHERE project_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
      [projectId, references],
    );
    const active = new Set(result.rows.map((row) => String(row.id)));
    const missing = references.find((reference) => !active.has(reference));
    if (missing) {
      throw new BadRequestException(
        `Protected credential "${missing}" is invalid or unavailable for this project.`,
      );
    }
  }

  private async requireProject(principal: Principal, projectId: string) {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const result = await this.database.query(
      `SELECT 1 FROM projects
       WHERE id = $1 AND ($2::uuid IS NULL OR workspace_id = $2)`,
      [projectId, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Project not found");
  }

  private async workspaceFor(principal: Principal) {
    if (principal.kind === "user") return principal.workspaceId;
    const serviceWorkspace = await this.database.query(
      "SELECT id FROM workspaces WHERE slug = 'scry-service'",
    );
    if (!serviceWorkspace.rowCount) throw new Error("Service workspace is missing");
    return serviceWorkspace.rows[0]!.id as string;
  }

  requireWriteAccess(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer") {
      throw new ForbiddenException("Workspace viewers have read-only access");
    }
  }
}

function isPostgresUniqueViolation(error: unknown): error is { code: "23505" } {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
