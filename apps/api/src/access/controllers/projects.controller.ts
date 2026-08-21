import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
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
import { ScryRepository } from "../repositories/scry.repository.js";

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

  @Post("operating-context")
  operatingContext(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(getOperatingContextSchema)) input: GetOperatingContextInput,
  ) {
    return this.repository.operatingContext(principal, input);
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
