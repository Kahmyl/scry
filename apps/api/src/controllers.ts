import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  StreamableFile,
} from "@nestjs/common";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createEnvironmentSchema,
  createAtomicRevisionSchema,
  createCredentialSchema,
  createPlanVersionSchema,
  createProjectSchema,
  createRunSchema,
  createSpecificationVersionSchema,
  createTestSpecificationSchema,
  updateEnvironmentSchema,
  updateTestSpecificationSchema,
  updateCredentialSchema,
  validateCredentialReferencesSchema,
  type CreateEnvironmentInput,
  type CreateAtomicRevisionInput,
  type CreateCredentialInput,
  type CreatePlanVersionInput,
  type CreateProjectInput,
  type CreateRunInput,
  type CreateSpecificationVersionInput,
  type CreateTestSpecificationInput,
  type UpdateEnvironmentInput,
  type UpdateTestSpecificationInput,
  type UpdateCredentialInput,
  type ValidateCredentialReferencesInput,
} from "@scry/contracts";

import { ScryRepository } from "./repository.js";
import { RunQueueService } from "./queue.service.js";
import { ZodValidationPipe } from "./validation.pipe.js";
import { Public } from "./auth.guard.js";
import type { Principal } from "./auth.types.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import { McpTokenRepository } from "./mcp-token.repository.js";

@Controller("health")
@Public()
export class HealthController {
  @Get()
  health() {
    return { status: "ok" };
  }
}

@Controller("mcp-tokens")
export class McpTokensController {
  constructor(@Inject(McpTokenRepository) private readonly tokens: McpTokenRepository) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal) {
    return this.tokens.list(principal);
  }

  @Post()
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() input: { name?: string },
  ) {
    return this.tokens.create(principal, input.name?.trim() || "MCP connection");
  }

  @Delete(":tokenId")
  revoke(
    @Param("tokenId") tokenId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.tokens.revoke(principal, tokenId);
  }
}

@Controller("projects")
export class ProjectsController {
  constructor(@Inject(ScryRepository) private readonly repository: ScryRepository) {}

  @Post()
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createProjectSchema)) input: CreateProjectInput,
  ) {
    return this.repository.createProject(principal, input);
  }

  @Get()
  list(@CurrentPrincipal() principal: Principal) {
    return this.repository.listProjects(principal);
  }

  @Post(":projectId/environments")
  createEnvironment(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createEnvironmentSchema)) input: CreateEnvironmentInput,
  ) {
    return this.repository.createEnvironment(principal, projectId, input);
  }

  @Get(":projectId/environments")
  listEnvironments(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.repository.listEnvironments(principal, projectId);
  }

  @Get(":projectId/credentials")
  listCredentials(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.repository.listCredentials(principal, projectId);
  }

  @Post(":projectId/credentials")
  createCredential(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createCredentialSchema)) input: CreateCredentialInput,
  ) {
    return this.repository.createCredential(principal, projectId, input);
  }

  @Post(":projectId/specifications")
  createSpecification(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createTestSpecificationSchema))
    input: CreateTestSpecificationInput,
  ) {
    return this.repository.createSpecification(principal, projectId, input);
  }

  @Get(":projectId/specifications")
  listSpecifications(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.repository.listSpecifications(principal, projectId);
  }

  @Post(":projectId/runs")
  createRun(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createRunSchema)) input: CreateRunInput,
  ) {
    return this.repository.createRun(principal, projectId, input);
  }

  @Get(":projectId/runs")
  listRuns(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.repository.listRuns(principal, projectId);
  }
}

@Controller("specifications")
export class SpecificationsController {
  constructor(@Inject(ScryRepository) private readonly repository: ScryRepository) {}

  @Patch(":specificationId")
  update(
    @Param("specificationId") specificationId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(updateTestSpecificationSchema))
    input: UpdateTestSpecificationInput,
  ) {
    return this.repository.updateSpecification(principal, specificationId, input);
  }

  @Post(":specificationId/versions")
  createVersion(
    @Param("specificationId") specificationId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createSpecificationVersionSchema))
    input: CreateSpecificationVersionInput,
  ) {
    return this.repository.createSpecificationVersion(principal, specificationId, input);
  }

  @Post(":specificationId/revisions")
  revise(
    @Param("specificationId") specificationId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createAtomicRevisionSchema)) input: CreateAtomicRevisionInput,
  ) {
    return this.repository.createAtomicRevision(principal, specificationId, input);
  }
}

@Controller("environments")
export class EnvironmentsController {
  constructor(@Inject(ScryRepository) private readonly repository: ScryRepository) {}

  @Patch(":environmentId")
  update(
    @Param("environmentId") environmentId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(updateEnvironmentSchema))
    input: UpdateEnvironmentInput,
  ) {
    return this.repository.updateEnvironment(principal, environmentId, input);
  }

  @Post(":environmentId/validate-credentials")
  validateCredentials(
    @Param("environmentId") environmentId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(validateCredentialReferencesSchema)) input: ValidateCredentialReferencesInput,
  ) {
    return this.repository.validateCredentialReferences(principal, environmentId, input);
  }
}

@Controller("credentials")
export class CredentialsController {
  constructor(@Inject(ScryRepository) private readonly repository: ScryRepository) {}

  @Patch(":credentialId")
  update(
    @Param("credentialId") credentialId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(updateCredentialSchema)) input: UpdateCredentialInput,
  ) {
    return this.repository.updateCredential(principal, credentialId, input);
  }

  @Delete(":credentialId")
  remove(
    @Param("credentialId") credentialId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.repository.deleteCredential(principal, credentialId);
  }
}

@Controller("plans")
export class PlansController {
  constructor(@Inject(ScryRepository) private readonly repository: ScryRepository) {}

  @Post("versions")
  createVersion(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createPlanVersionSchema)) input: CreatePlanVersionInput,
  ) {
    return this.repository.createPlanVersion(principal, input);
  }
}

@Controller("runs")
export class RunsController {
  constructor(
    @Inject(ScryRepository) private readonly repository: ScryRepository,
    @Inject(RunQueueService) private readonly queue: RunQueueService,
  ) {}

  @Get(":runId")
  get(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return this.repository.getRun(principal, runId);
  }

  @Get(":runId/report")
  report(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return this.repository.getRunReport(principal, runId);
  }

  @Post(":runId/start")
  async start(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    this.repository.requireWriteAccess(principal);
    await this.repository.validateRunCredentials(principal, runId);
    return this.queue.start(runId);
  }

  @Post(":runId/cancel")
  async cancel(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    this.repository.requireWriteAccess(principal);
    await this.repository.getRun(principal, runId);
    return this.queue.cancel(runId);
  }

  @Post(":runId/rerun")
  async rerun(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    const run = await this.repository.rerunExact(principal, runId);
    await this.queue.start(run.id);
    return run;
  }
}

@Controller("artifacts")
export class ArtifactsController {
  constructor(@Inject(ScryRepository) private readonly repository: ScryRepository) {}

  @Get(":artifactId")
  @Header("Cache-Control", "private, max-age=300")
  async get(
    @Param("artifactId") artifactId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    const artifact = await this.repository.getArtifact(principal, artifactId);
    if (artifact.status !== "available" || !artifact.storageKey) {
      throw new NotFoundException("Artifact is not available");
    }
    const root = path.resolve(process.env.ARTIFACT_ROOT ?? "artifacts/runs");
    const target = path.resolve(root, artifact.storageKey);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new NotFoundException("Artifact path is invalid");
    }
    try {
      return new StreamableFile(await readFile(target), {
        type: artifact.contentType,
        disposition: `inline; filename="${path.basename(target)}"`,
      });
    } catch {
      throw new NotFoundException("Artifact file is missing");
    }
  }
}
