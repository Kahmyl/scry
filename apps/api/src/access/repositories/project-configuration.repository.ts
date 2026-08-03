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
  UpdateCredentialInput,
  UpdateEnvironmentInput,
  ValidateCredentialReferencesInput,
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
    return (
      await this.database.query(
        `SELECT id, project_id AS "projectId", name,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM project_credentials
         WHERE project_id = $1 AND deleted_at IS NULL
         ORDER BY name`,
        [projectId],
      )
    ).rows;
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
    const context = await this.database.query(
      `SELECT 1 FROM missions m JOIN mission_objectives o ON o.mission_id=m.id AND o.id=$3
       JOIN agent_sessions s ON s.mission_id=m.id AND s.id=$4 AND s.status='active'
       WHERE m.id=$2 AND m.project_id=$1`,
      [projectId, input.missionId, input.objectiveId, input.agentSessionId],
    );
    if (!context.rowCount) throw new BadRequestException({ code: "MISSION_CONTEXT_INVALID" });
    const encrypted = encryptCredential(input.value);
    try {
      const result = await this.database.query(
        `INSERT INTO project_credentials(project_id,name,ciphertext,initialization_vector,authentication_tag,origin_mission_id,origin_objective_id,created_by_agent_session_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, project_id AS "projectId", name,
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          projectId,
          input.name,
          encrypted.ciphertext,
          encrypted.initializationVector,
          encrypted.authenticationTag,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
        ],
      );
      await this.database.query(
        `INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata) VALUES($1,$2,$3,'credential_created',$4,$5::jsonb)`,
        [
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          `Credential created: ${input.name}`,
          JSON.stringify({ credentialId: result.rows[0]!.id }),
        ],
      );
      return result.rows[0]!;
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
      `UPDATE project_credentials credential
       SET name = $2, ciphertext = $3, initialization_vector = $4,
           authentication_tag = $5, updated_at = now()
       FROM projects project
       WHERE credential.id = $1 AND credential.deleted_at IS NULL
         AND project.id = credential.project_id
         AND ($6::uuid IS NULL OR project.workspace_id = $6)
       RETURNING credential.id, credential.project_id AS "projectId",
                 credential.name, credential.created_at AS "createdAt",
                 credential.updated_at AS "updatedAt"`,
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
       WHERE project_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
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
    const environment = await this.database.query(
      `SELECT environment.project_id AS "projectId"
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
        JSON.stringify(input.policy),
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
      `SELECT id::text FROM project_credentials WHERE project_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
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

function isPostgresUniqueViolation(error: unknown): error is { code: "23505" } {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
