import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import {
  createEnvironmentSchema,
  createCredentialSchema,
  createProjectSchema,
  updateEnvironmentSchema,
  updateCredentialSchema,
  validateCredentialReferencesSchema,
  type CreateEnvironmentInput,
  type CreateCredentialInput,
  type CreateProjectInput,
  type UpdateEnvironmentInput,
  type UpdateCredentialInput,
  type ValidateCredentialReferencesInput,
  veilPreferenceUpdateSchema,
  type VeilPreferenceUpdate,
} from "@scry/contracts";

import { ScryRepository } from "./repository.js";
import { RunQueueService } from "./queue.service.js";
import { ZodValidationPipe } from "./validation.pipe.js";
import { Public } from "./auth.guard.js";
import type { Principal } from "./auth.types.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import { McpTokenRepository } from "./mcp-token.repository.js";
import { RunObservationService } from "./run-observation.service.js";
import { ReleaseAdmissionService } from "./release-admission.service.js";
import { VeilPreferencesService } from "./veil-preferences.service.js";

@Controller("api/health")
@Public()
export class HealthController {
  @Get()
  health() {
    return { status: "ok" };
  }
}

@Controller("api/mcp-tokens")
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

@Controller("api/projects")
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

  @Get(":projectId/credential-incidents")
  listCredentialIncidents(@Param("projectId") projectId: string, @CurrentPrincipal() principal: Principal) {
    return this.repository.listCredentialIncidents(principal, projectId);
  }

  @Post(":projectId/credentials")
  createCredential(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createCredentialSchema)) input: CreateCredentialInput,
  ) {
    return this.repository.createCredential(principal, projectId, input);
  }

  @Get(":projectId/runs")
  listRuns(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.repository.listRuns(principal, projectId);
  }
}

@Controller("api/environments")
export class EnvironmentsController {
  constructor(
    @Inject(ScryRepository) private readonly repository: ScryRepository,
    @Inject(VeilPreferencesService) private readonly veilPreferences: VeilPreferencesService,
  ) {}

  @Get(":environmentId/veil")
  getVeil(@Param("environmentId") environmentId: string, @CurrentPrincipal() principal: Principal) {
    return this.veilPreferences.get(principal, environmentId);
  }

  @Patch(":environmentId/veil")
  tightenVeil(
    @Param("environmentId") environmentId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(veilPreferenceUpdateSchema)) input: VeilPreferenceUpdate,
  ) {
    return this.veilPreferences.tighten(principal, environmentId, input);
  }

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

@Controller("api/credentials")
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

@Controller("api/runs")
export class RunsController {
  constructor(
    @Inject(ScryRepository) private readonly repository: ScryRepository,
    @Inject(RunQueueService) private readonly queue: RunQueueService,
    @Inject(RunObservationService) private readonly observations: RunObservationService,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
  ) {}

  @Get(":runId")
  get(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return this.observations.observe(principal, runId);
  }

  @Get(":runId/veil")
  async getVeil(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return (await this.observations.observe(principal, runId)).veil;
  }

  @Post(":runId/start")
  async start(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    await this.admission.assertAcceptingWork();
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
    await this.admission.assertAcceptingWork();
    const run = await this.repository.rerunExact(principal, runId);
    await this.queue.dispatchPending();
    return run;
  }
}
