import { Body, Controller, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import {
  compileFlowDraftSchema,
  createAuthenticationContractSchema,
  createFlowDraftSchema,
  publishFlowDraftSchema,
  startProbeSessionSchema,
  updateFlowDraftSchema,
  type CompileFlowDraftInput,
  type CreateAuthenticationContractInput,
  type CreateFlowDraftInput,
  type PublishFlowDraftInput,
  type StartProbeSessionInput,
  type UpdateFlowDraftInput,
} from "@scry/contracts";
import { z } from "zod";

import type { Principal } from "../auth/index.js";
import { AuthoringService } from "./authoring.service.js";
import { CurrentPrincipal } from "../auth/index.js";
import { RunQueueService } from "../runtime/index.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";

const cancelSchema = z
  .object({ missionId: z.string().uuid(), agentSessionId: z.string().uuid() })
  .strict();
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
    @Inject(RunQueueService) private readonly queue: RunQueueService,
  ) {}
  @Post("flow-drafts") create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createFlowDraftSchema)) input: CreateFlowDraftInput,
  ) {
    return this.authoring.createDraft(p, input);
  }
  @Patch("flow-drafts/:draftId") update(
    @Param("draftId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(updateFlowDraftSchema)) input: UpdateFlowDraftInput,
  ) {
    return this.authoring.updateDraft(p, id, input);
  }
  @Get("flow-drafts/:draftId") get(@Param("draftId") id: string, @CurrentPrincipal() p: Principal) {
    return this.authoring.getDraft(p, id);
  }
  @Get("missions/:missionId/flow-drafts") list(
    @Param("missionId") id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.authoring.listDrafts(p, id);
  }
  @Post("flow-drafts/:draftId/abandon") abandon(
    @Param("draftId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(abandonSchema)) input: z.infer<typeof abandonSchema>,
  ) {
    return this.authoring.abandonDraft(p, id, input);
  }
  @Post("flow-drafts/:draftId/probes") async probe(
    @Param("draftId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(startProbeSessionSchema)) input: StartProbeSessionInput,
  ) {
    const result = await this.authoring.startProbe(p, id, input);
    await this.queue.dispatchPending();
    return result;
  }
  @Post("probe-sessions/:probeId/cancel") cancel(
    @Param("probeId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(cancelSchema)) input: z.infer<typeof cancelSchema>,
  ) {
    return this.authoring.cancelProbe(p, id, input.missionId, input.agentSessionId);
  }
  @Get("probe-sessions/:probeId") getProbe(
    @Param("probeId") id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.authoring.getProbe(p, id);
  }
  @Post("flow-drafts/:draftId/compile") compile(
    @Param("draftId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(compileFlowDraftSchema)) input: CompileFlowDraftInput,
  ) {
    return this.authoring.compile(p, id, input);
  }
  @Post("flow-drafts/:draftId/publish") publish(
    @Param("draftId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(publishFlowDraftSchema)) input: PublishFlowDraftInput,
  ) {
    return this.authoring.publish(p, id, input);
  }
  @Post("authentication-contracts") auth(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createAuthenticationContractSchema))
    input: CreateAuthenticationContractInput,
  ) {
    return this.authoring.createAuthenticationContract(p, input);
  }
  @Get("projects/:projectId/authentication-contracts") authContracts(
    @Param("projectId") id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.authoring.listAuthenticationContracts(p, id);
  }
  @Get("projects/:projectId/authenticated-session-leases") sessionLeases(
    @Param("projectId") id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.authoring.listSessionLeases(p, id);
  }
  @Post("authenticated-session-leases/:leaseId/revoke") revokeLease(
    @Param("leaseId") id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.authoring.revokeSessionLease(p, id);
  }
}
