import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import {
  createCredentialSchema,
  createEnvironmentSchema,
  createProjectSchema,
  getOperatingContextSchema,
  listCredentialsSchema,
  type CreateCredentialInput,
  type CreateEnvironmentInput,
  type CreateProjectInput,
  type GetOperatingContextInput,
  type ListCredentialsInput,
} from "@scry/contracts";

import { CurrentPrincipal, type Principal } from "../../auth/index.js";
import { ZodValidationPipe } from "../../common/validation.pipe.js";
import { ExternalAgentLifecycleService } from "../../runs/services/external-agent-lifecycle.service.js";
import { ScryRepository } from "../repositories/scry.repository.js";

@Controller("api/projects")
export class ProjectsController {
  constructor(
    @Inject(ScryRepository) private readonly repository: ScryRepository,
    @Inject(ExternalAgentLifecycleService)
    private readonly externalAgents: ExternalAgentLifecycleService,
  ) {}

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

  @Post("operating-context")
  async operatingContext(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(getOperatingContextSchema)) input: GetOperatingContextInput,
    @Headers("x-scry-external-run-id") externalRunId?: string,
  ) {
    const validExternalRunId =
      externalRunId && uuidPattern.test(externalRunId) ? externalRunId : undefined;
    const context = await this.repository.operatingContext(
      principal,
      input,
      validExternalRunId ? { externalRunId: validExternalRunId } : {},
    );
    if (validExternalRunId && context.selection.project)
      await this.externalAgents.observeOperatingContext(
        principal,
        validExternalRunId,
        context.selection.project.id,
        context,
      );
    return context;
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
  listCredentials(@Param("projectId") projectId: string, @CurrentPrincipal() principal: Principal) {
    return this.repository.listCredentials(principal, projectId);
  }

  @Get(":projectId/credential-candidates")
  listCredentialCandidates(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(listCredentialsSchema)) input: ListCredentialsInput,
  ) {
    return this.repository.listCredentialCandidates(principal, projectId, input);
  }

  @Get(":projectId/credential-incidents")
  listCredentialIncidents(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
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
  listRuns(@Param("projectId") projectId: string, @CurrentPrincipal() principal: Principal) {
    return this.repository.listRuns(principal, projectId);
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
