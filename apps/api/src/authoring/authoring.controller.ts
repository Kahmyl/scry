import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import {
  createAuthenticationContractSchema,
  createFlowDraftSchema,
  publishFlowDraftSchema,
  type CreateAuthenticationContractInput,
  type CreateFlowDraftInput,
  type PublishFlowDraftInput,
} from "@scry/contracts";
import { z } from "zod";

import type { Principal } from "../auth/index.js";
import { CurrentPrincipal } from "../auth/index.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";
import { AuthoringService } from "./authoring.service.js";

const abandonSchema = z
  .object({
    missionId: z.string().uuid(),
    objectiveId: z.string().uuid(),
    agentSessionId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

@Controller("api")
export class AuthoringController {
  constructor(
    @Inject(AuthoringService) private readonly authoring: AuthoringService,
  ) {}

  @Post("flow-drafts")
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createFlowDraftSchema)) input: CreateFlowDraftInput,
  ) {
    return this.authoring.createDraft(p, input);
  }

  @Get("flow-drafts/:draftId")
  get(@Param("draftId") id: string, @CurrentPrincipal() p: Principal) {
    return this.authoring.getDraft(p, id);
  }

  @Get("missions/:missionId/flow-drafts")
  list(@Param("missionId") id: string, @CurrentPrincipal() p: Principal) {
    return this.authoring.listDrafts(p, id);
  }

  @Post("flow-drafts/:draftId/abandon")
  abandon(
    @Param("draftId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(abandonSchema)) input: z.infer<typeof abandonSchema>,
  ) {
    return this.authoring.abandonDraft(p, id, input);
  }

  @Post("flow-drafts/:draftId/publish")
  publish(
    @Param("draftId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(publishFlowDraftSchema)) input: PublishFlowDraftInput,
  ) {
    return this.authoring.publish(p, id, input);
  }

  @Post("authentication-contracts")
  auth(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createAuthenticationContractSchema))
    input: CreateAuthenticationContractInput,
  ) {
    return this.authoring.createAuthenticationContract(p, input);
  }

  @Get("projects/:projectId/authentication-contracts")
  authContracts(@Param("projectId") id: string, @CurrentPrincipal() p: Principal) {
    return this.authoring.listAuthenticationContracts(p, id);
  }

  @Get("projects/:projectId/authenticated-session-leases")
  sessionLeases(@Param("projectId") id: string, @CurrentPrincipal() p: Principal) {
    return this.authoring.listSessionLeases(p, id);
  }

  @Post("authenticated-session-leases/:leaseId/revoke")
  revokeLease(@Param("leaseId") id: string, @CurrentPrincipal() p: Principal) {
    return this.authoring.revokeSessionLease(p, id);
  }
}
