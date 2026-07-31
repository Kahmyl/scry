import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";

import { analyzePlanRisks } from "@scry/contracts";
import type {
  CreateEnvironmentInput,
  CreateAtomicRevisionInput,
  CreateCredentialInput,
  CreatePlanVersionInput,
  CreateProjectInput,
  CreateRunInput,
  CreateSpecificationVersionInput,
  CreateTestSpecificationInput,
  UpdateEnvironmentInput,
  ValidateCredentialReferencesInput,
  UpdateTestSpecificationInput,
  UpdateCredentialInput,
} from "@scry/contracts";

import { Database } from "./database.js";
import type { Principal } from "./auth.types.js";
import { encryptCredential } from "./credential.crypto.js";

@Injectable()
export class ScryRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

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

  async createCredential(principal: Principal, projectId: string, input: CreateCredentialInput) {
    this.requireWriteAccess(principal);
    await this.requireProject(principal, projectId);
    const encrypted = encryptCredential(input.value);
    const result = await this.database.query(
      `INSERT INTO project_credentials(
         project_id, name, ciphertext, initialization_vector, authentication_tag
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, project_id AS "projectId", name,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [projectId, input.name, encrypted.ciphertext, encrypted.initializationVector, encrypted.authenticationTag],
    );
    return result.rows[0]!;
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
      [credentialId, input.name, encrypted.ciphertext, encrypted.initializationVector, encrypted.authenticationTag, workspaceId],
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

  async listSpecifications(principal: Principal, projectId: string) {
    await this.requireProject(principal, projectId);
    return (
      await this.database.query(
        `SELECT ts.id, ts.project_id AS "projectId", ts.name, ts.description,
                ts.created_at AS "createdAt",
                complete.id AS "latestVersionId", complete.version AS "latestVersion",
                complete.content AS "latestContent",
                complete.plan_version_id AS "latestPlanVersionId", complete.plan AS "latestPlan"
         FROM test_specifications ts
         LEFT JOIN LATERAL (
           SELECT sv.id, sv.version, sv.content,
                  pv.id AS plan_version_id, pv.plan
           FROM specification_versions sv
           JOIN plan_versions pv ON pv.specification_version_id = sv.id
           WHERE sv.specification_id = ts.id
           ORDER BY pv.version DESC
           LIMIT 1
         ) complete ON true
         WHERE ts.project_id = $1 ORDER BY ts.updated_at DESC`,
        [projectId],
      )
    ).rows;
  }

  async listRuns(principal: Principal, projectId: string) {
    await this.requireProject(principal, projectId);
    return (
      await this.database.query(
        `SELECT r.id, r.state, r.outcome_classification AS "outcomeClassification",
                r.created_at AS "createdAt", r.updated_at AS "updatedAt",
                r.execution_snapshot AS "executionSnapshot",
                r.environment_snapshot AS "environmentSnapshot",
                r.plan_snapshot->>'name' AS "planName",
                r.rerun_of_run_id AS "rerunOfRunId",
                r.resolved_at AS "resolvedAt",
                r.resolved_by_run_id AS "resolvedByRunId",
                r.confirmation_of_run_id AS "confirmationOfRunId",
                r.confirmation_run_id AS "confirmationRunId",
                (
                  r.state IN ('failed','timed_out','infrastructure_error')
                  AND r.resolved_at IS NULL
                ) AS "needsAttention",
                COALESCE(a.attempt_count, 0)::int AS "attemptCount"
         FROM runs r
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS attempt_count FROM attempts WHERE run_id = r.id
         ) a ON true
         WHERE r.project_id = $1 ORDER BY r.created_at DESC`,
        [projectId],
      )
    ).rows;
  }

  async createEnvironment(principal: Principal, projectId: string, input: CreateEnvironmentInput) {
    this.requireWriteAccess(principal);
    await this.requireProject(principal, projectId);
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
      [projectId, input.name, input.baseOrigin, JSON.stringify(input.policy), JSON.stringify(input.secretRefs)],
    );
    return result.rows[0]!;
  }

  async createSpecification(principal: Principal, projectId: string, input: CreateTestSpecificationInput) {
    this.requireWriteAccess(principal);
    await this.requireProject(principal, projectId);
    const result = await this.database.query(
      `INSERT INTO test_specifications(project_id, name, description) VALUES ($1, $2, $3)
       RETURNING id, project_id AS "projectId", name, description, created_at AS "createdAt"`,
      [projectId, input.name, input.description],
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
      return { valid: false, errors: [{
          code: "CREDENTIAL_NOT_AUTHORIZED",
          message: `Protected credential "${unavailable}" is not authorized in the selected environment.`,
      }] };
    }
    const active = await this.database.query<{ id: string }>(
      `SELECT id::text FROM project_credentials
       WHERE project_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
      [input.projectId, input.secretRefs],
    );
    const activeIds = new Set(active.rows.map(({ id }) => String(id)));
    const missing = input.secretRefs.find((reference) => !activeIds.has(reference));
    if (missing) return { valid: false, errors: [{
      code: "CREDENTIAL_UNAVAILABLE",
      message: `Protected credential "${missing}" is invalid or unavailable for this project.`,
    }] };
    return { valid: true };
  }

  async updateSpecification(principal: Principal, specificationId: string, input: UpdateTestSpecificationInput) {
    this.requireWriteAccess(principal);
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const result = await this.database.query(
      `UPDATE test_specifications ts
       SET name = $2, description = $3, updated_at = now()
       FROM projects p
       WHERE ts.id = $1 AND p.id = ts.project_id
         AND ($4::uuid IS NULL OR p.workspace_id = $4)
       RETURNING ts.id, ts.project_id AS "projectId", ts.name, ts.description,
                 ts.created_at AS "createdAt", ts.updated_at AS "updatedAt"`,
      [specificationId, input.name, input.description, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Test specification not found");
    return result.rows[0]!;
  }

  async updateEnvironment(principal: Principal, environmentId: string, input: UpdateEnvironmentInput) {
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
      [environmentId, input.baseOrigin, JSON.stringify(input.policy), JSON.stringify(input.secretRefs), workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Flow environment not found");
    return result.rows[0]!;
  }

  async createSpecificationVersion(
    principal: Principal,
    specificationId: string,
    input: CreateSpecificationVersionInput,
  ) {
    this.requireWriteAccess(principal);
    return this.database.transaction(async (client) => {
      await this.requireSpecification(client, principal, specificationId);
      const result = await client.query(
        `INSERT INTO specification_versions(specification_id, version, content)
         SELECT $1, COALESCE(MAX(version), 0) + 1, $2::jsonb
         FROM specification_versions WHERE specification_id = $1
         RETURNING id, specification_id AS "specificationId", version, content, created_at AS "createdAt"`,
        [specificationId, JSON.stringify(input)],
      );
      return result.rows[0]!;
    });
  }

  async createPlanVersion(principal: Principal, input: CreatePlanVersionInput) {
    this.requireWriteAccess(principal);
    const risks = analyzePlanRisks(input.plan);
    if (risks.errors.length > 0) {
      throw new BadRequestException({
        message: "Plan has conclusive-evidence validation errors",
        errors: risks.errors,
        warnings: risks.warnings,
      });
    }
    return this.database.transaction(async (client) => {
      await this.requireSpecificationVersion(client, principal, input.specificationVersionId);
      const result = await client.query(
        `INSERT INTO plan_versions(specification_version_id, version, protocol_version, plan)
         SELECT $1, COALESCE(MAX(pv.version), 0) + 1, $2, $3::jsonb
         FROM specification_versions target
         LEFT JOIN specification_versions sibling
           ON sibling.specification_id = target.specification_id
         LEFT JOIN plan_versions pv ON pv.specification_version_id = sibling.id
         WHERE target.id = $1
         RETURNING id, specification_version_id AS "specificationVersionId", version,
                   protocol_version AS "protocolVersion", plan, created_at AS "createdAt"`,
        [input.specificationVersionId, input.plan.protocolVersion, JSON.stringify(input.plan)],
      );
      return result.rows[0]!;
    });
  }

  async createAtomicRevision(
    principal: Principal,
    specificationId: string,
    input: CreateAtomicRevisionInput,
  ) {
    this.requireWriteAccess(principal);
    const risks = analyzePlanRisks(input.plan);
    if (risks.errors.length > 0) {
      throw new BadRequestException({
        message: "Plan has conclusive-evidence validation errors",
        errors: risks.errors,
        warnings: risks.warnings,
      });
    }
    return this.database.transaction(async (client) => {
      await this.requireSpecification(client, principal, specificationId);
      if (input.name !== undefined || input.description !== undefined) {
        await client.query(
          `UPDATE test_specifications
           SET name = COALESCE($2, name), description = COALESCE($3, description), updated_at = now()
           WHERE id = $1`,
          [specificationId, input.name ?? null, input.description ?? null],
        );
      }
      const specificationVersion = await client.query(
        `INSERT INTO specification_versions(specification_id, version, content)
         SELECT $1, COALESCE(MAX(version), 0) + 1, $2::jsonb
         FROM specification_versions WHERE specification_id = $1
         RETURNING id, version`,
        [specificationId, JSON.stringify(input.content)],
      );
      const planVersion = await client.query(
        `INSERT INTO plan_versions(specification_version_id, version, protocol_version, plan)
         SELECT $1, COALESCE(MAX(pv.version), 0) + 1, $2, $3::jsonb
         FROM specification_versions sibling
         LEFT JOIN plan_versions pv ON pv.specification_version_id = sibling.id
         WHERE sibling.specification_id = $4
         RETURNING id, version`,
        [specificationVersion.rows[0]!.id, input.plan.protocolVersion, JSON.stringify(input.plan), specificationId],
      );
      return {
        specificationId,
        specificationVersionId: specificationVersion.rows[0]!.id,
        specificationVersion: specificationVersion.rows[0]!.version,
        planVersionId: planVersion.rows[0]!.id,
        planVersion: planVersion.rows[0]!.version,
        warnings: risks.warnings,
      };
    });
  }

  async createRun(principal: Principal, projectId: string, input: CreateRunInput) {
    this.requireWriteAccess(principal);
    await this.requireProject(principal, projectId);
    return this.database.transaction(async (client) => {
      const environment = await client.query(
        `SELECT id, project_id, name, base_origin, policy, secret_refs
         FROM environments WHERE id = $1 AND project_id = $2`,
        [input.environmentId, projectId],
      );
      if (!environment.rowCount) throw new NotFoundException("Environment not found");
      const plan = await client.query(
        `SELECT pv.id, pv.plan, pv.protocol_version, sv.specification_id
         FROM plan_versions pv
         JOIN specification_versions sv ON sv.id = pv.specification_version_id
         JOIN test_specifications ts ON ts.id = sv.specification_id
         WHERE pv.id = $1 AND ts.project_id = $2`,
        [input.planVersionId, projectId],
      );
      if (!plan.rowCount) throw new NotFoundException("Plan version not found");
      const environmentRow = environment.rows[0]!;
      const planRow = plan.rows[0]!;
      const planSecretRefs = this.planSecretRefs(planRow.plan);
      const environmentSecretRefs = new Set<string>(environmentRow.secret_refs);
      const unavailableRef = planSecretRefs.find(
        (reference) => !environmentSecretRefs.has(reference),
      );
      if (unavailableRef) {
        throw new BadRequestException(
          `Protected credential "${unavailableRef}" is not available in the selected Flow environment.`,
        );
      }
      await this.requireActiveCredentials(
        (text, values) => client.query<{ id: string }>(text, values),
        projectId,
        planSecretRefs,
      );
      const execution = { browser: input.browser, viewport: input.viewport, seed: input.seed };
      const result = await client.query(
        `INSERT INTO runs(
           project_id, environment_id, plan_version_id, state,
           plan_snapshot, environment_snapshot, policy_snapshot, execution_snapshot
         ) VALUES ($1, $2, $3, 'draft', $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
         RETURNING id, project_id AS "projectId", environment_id AS "environmentId",
                   plan_version_id AS "planVersionId", state, plan_snapshot AS "planSnapshot",
                   environment_snapshot AS "environmentSnapshot", policy_snapshot AS "policySnapshot",
                   execution_snapshot AS "executionSnapshot", created_at AS "createdAt"`,
        [
          projectId,
          input.environmentId,
          input.planVersionId,
          JSON.stringify(planRow.plan),
          JSON.stringify({
            id: environmentRow.id,
            name: environmentRow.name,
            baseOrigin: environmentRow.base_origin,
            secretRefs: environmentRow.secret_refs,
          }),
          JSON.stringify(environmentRow.policy),
          JSON.stringify(execution),
        ],
      );
      return result.rows[0]!;
    });
  }

  async getRun(principal: Principal, runId: string) {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const run = await this.database.query(
      `SELECT runs.id, runs.project_id AS "projectId", runs.environment_id AS "environmentId",
              runs.plan_version_id AS "planVersionId", runs.state,
              runs.outcome_classification AS "outcomeClassification",
              runs.rerun_of_run_id AS "rerunOfRunId",
              runs.resolved_at AS "resolvedAt",
              runs.resolved_by_run_id AS "resolvedByRunId",
              runs.confirmation_of_run_id AS "confirmationOfRunId",
              runs.confirmation_run_id AS "confirmationRunId",
              (
                runs.state IN ('failed','timed_out','infrastructure_error')
                AND runs.resolved_at IS NULL
              ) AS "needsAttention",
              runs.plan_snapshot AS "planSnapshot",
              runs.environment_snapshot AS "environmentSnapshot",
              runs.policy_snapshot AS "policySnapshot",
              runs.execution_snapshot AS "executionSnapshot",
              CASE
                WHEN runs.state = 'finalizing' THEN 'finalizing'
                WHEN latest_event.type = 'step.evidence_started' THEN 'capturing_evidence'
                WHEN runs.state = 'running' THEN 'executing_steps'
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

  async getRunReport(principal: Principal, runId: string) {
    const run = await this.getRun(principal, runId);
    const attempts = (
      await this.database.query(
        `SELECT id, attempt_number AS "attemptNumber", state, started_at AS "startedAt",
                completed_at AS "completedAt", error
         FROM attempts WHERE run_id = $1 ORDER BY attempt_number`,
        [runId],
      )
    ).rows;
    const attemptIds = attempts.map((attempt) => attempt.id);
    if (attemptIds.length === 0) {
      return { run, attempts: [], events: [], assertions: [], artifacts: [] };
    }
    const events = (
      await this.database.query(
        `SELECT id, attempt_id AS "attemptId", sequence, type, payload,
                occurred_at AS "occurredAt"
         FROM run_events WHERE attempt_id = ANY($1::uuid[])
         ORDER BY attempt_id, sequence`,
        [attemptIds],
      )
    ).rows;
    const assertions = (
      await this.database.query(
        `SELECT attempt_id AS "attemptId", step_id AS "stepId",
                assertion_index AS "assertionIndex", assertion_type AS "assertionType",
                status, error FROM assertion_results WHERE attempt_id = ANY($1::uuid[])
         ORDER BY attempt_id, step_id, assertion_index`,
        [attemptIds],
      )
    ).rows;
    const artifacts = (
      await this.database.query(
        `SELECT id, attempt_id AS "attemptId", step_id AS "stepId", kind, status,
                content_type AS "contentType", storage_key AS "storageKey",
                size_bytes AS "sizeBytes", checksum_sha256 AS "checksumSha256",
                retention_until AS "retentionUntil", observation, created_at AS "createdAt"
         FROM artifacts WHERE attempt_id = ANY($1::uuid[]) ORDER BY created_at`,
        [attemptIds],
      )
    ).rows;
    return { run, attempts, events, assertions, artifacts };
  }

  async rerunExact(principal: Principal, runId: string) {
    this.requireWriteAccess(principal);
    const source = await this.validateRunCredentials(principal, runId);
    const result = await this.database.query(
      `INSERT INTO runs(
         project_id, environment_id, plan_version_id, state,
         plan_snapshot, environment_snapshot, policy_snapshot, execution_snapshot,
         rerun_of_run_id
       )
       SELECT project_id, environment_id, plan_version_id, 'draft',
              plan_snapshot, environment_snapshot, policy_snapshot, execution_snapshot, id
       FROM runs WHERE id = $1
       RETURNING id, project_id AS "projectId", environment_id AS "environmentId",
                 plan_version_id AS "planVersionId", state, created_at AS "createdAt"`,
      [source.id],
    );
    return result.rows[0]!;
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
      `SELECT a.id, a.kind, a.status, a.content_type AS "contentType",
              a.storage_key AS "storageKey", a.size_bytes AS "sizeBytes", a.observation
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
    return [...new Set(steps.flatMap((step) => {
      if (!step || typeof step !== "object") return [];
      const action = (step as { action?: unknown }).action;
      if (!action || typeof action !== "object") return [];
      const secretRef = (action as { secretRef?: unknown }).secretRef;
      return typeof secretRef === "string" ? [secretRef] : [];
    }))];
  }

  private async requireActiveCredentials(
    query: (text: string, values: unknown[]) => Promise<{ rows: Array<{ id: string }> }>,
    projectId: string,
    references: string[],
  ) {
    if (!references.length) return;
    const malformed = references.find((reference) =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference),
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

  private async requireSpecification(
    client: PoolClient,
    principal: Principal,
    specificationId: string,
  ) {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const result = await client.query(
      `SELECT 1
       FROM test_specifications ts
       JOIN projects p ON p.id = ts.project_id
       WHERE ts.id = $1 AND ($2::uuid IS NULL OR p.workspace_id = $2)
       FOR UPDATE OF ts`,
      [specificationId, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Test specification not found");
  }

  private async requireSpecificationVersion(
    client: PoolClient,
    principal: Principal,
    specificationVersionId: string,
  ) {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const result = await client.query(
      `SELECT 1
       FROM specification_versions sv
       JOIN test_specifications ts ON ts.id = sv.specification_id
       JOIN projects p ON p.id = ts.project_id
       WHERE sv.id = $1 AND ($2::uuid IS NULL OR p.workspace_id = $2)
       FOR UPDATE OF sv`,
      [specificationVersionId, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Specification version not found");
  }

  private async workspaceFor(principal: Principal) {
    if (principal.kind === "user") return principal.workspaceId;
    const legacy = await this.database.query(
      "SELECT id FROM workspaces WHERE slug = 'legacy'",
    );
    if (!legacy.rowCount) throw new Error("Legacy service workspace is missing");
    return legacy.rows[0]!.id as string;
  }

  requireWriteAccess(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer") {
      throw new ForbiddenException("Workspace viewers have read-only access");
    }
  }
}
