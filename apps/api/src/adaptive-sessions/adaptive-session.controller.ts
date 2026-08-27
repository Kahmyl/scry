import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import {
  closeAdaptiveSessionSchema,
  recoverTrustedOriginsSchema,
  prepareFlowAuthoringSchema,
  reconcileAdaptiveOperationSchema,
  startAdaptiveSessionSchema,
  type CloseAdaptiveSessionInput,
  type StartAdaptiveSessionInput,
  type RecoverTrustedOriginsInput,
  type PrepareFlowAuthoringInput,
  type ReconcileAdaptiveOperationInput,
} from "@scry/contracts";

import {
  inspectPraxisRegionInputSchema,
  inspectPraxisBrowserResourcesInputSchema,
  readPraxisPublicResourceInputSchema,
  readPraxisPublicValueInputSchema,
  type ReadPraxisPublicResourceInput,
  type InspectPraxisRegionInput,
  type ReadPraxisPublicValueInput,
} from "@scry/contracts";

import { CurrentPrincipal, type Principal } from "../auth/index.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";
import { MissionFlowAuthoringService } from "./mission-flow-authoring.service.js";

@Controller("api/mission-flow-authoring")
export class AdaptiveSessionController {
  constructor(
    @Inject(MissionFlowAuthoringService) private readonly sessions: MissionFlowAuthoringService,
  ) {}

  @Post()
  start(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(startAdaptiveSessionSchema)) input: StartAdaptiveSessionInput,
  ) {
    return this.sessions.start(principal, input);
  }

  @Post("prepare")
  prepare(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(prepareFlowAuthoringSchema)) input: PrepareFlowAuthoringInput,
  ) {
    return this.sessions.prepare(principal, input);
  }

  @Post("recover-trusted-origins")
  recoverTrustedOrigins(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(recoverTrustedOriginsSchema)) input: RecoverTrustedOriginsInput,
  ) {
    return this.sessions.recoverTrustedOrigins(principal, input);
  }

  @Get(":sessionId")
  get(@CurrentPrincipal() principal: Principal, @Param("sessionId") sessionId: string) {
    return this.sessions.get(principal, sessionId);
  }

  @Post(":sessionId/reconcile-unknown")
  reconcileUnknown(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(reconcileAdaptiveOperationSchema))
    input: ReconcileAdaptiveOperationInput,
  ) {
    return this.sessions.reconcileUnknown(principal, sessionId, input);
  }
  @Post(":sessionId/close")
  close(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(closeAdaptiveSessionSchema)) input: CloseAdaptiveSessionInput,
  ) {
    return this.sessions.close(principal, sessionId, input.idempotencyKey);
  }
}

/**
 * Agent-first public session surface. The legacy mission-flow-authoring routes
 * above remain read-compatible during R0.6 but cannot dispatch an authoring turn.
 */
@Controller("api/praxis-sessions")
export class PraxisSessionController {
  constructor(
    @Inject(MissionFlowAuthoringService) private readonly sessions: MissionFlowAuthoringService,
  ) {}

  @Post()
  start(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(startAdaptiveSessionSchema)) input: StartAdaptiveSessionInput,
  ) {
    return this.sessions.start(principal, input);
  }

  @Get(":sessionId")
  get(@CurrentPrincipal() principal: Principal, @Param("sessionId") sessionId: string) {
    return this.sessions.get(principal, sessionId);
  }

  @Get(":sessionId/observation")
  observe(@CurrentPrincipal() principal: Principal, @Param("sessionId") sessionId: string) {
    return this.sessions.observe(principal, sessionId);
  }

  @Post(":sessionId/public-values/read")
  readPublicValue(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(readPraxisPublicValueInputSchema))
    input: ReadPraxisPublicValueInput,
  ) {
    return this.sessions.readPublicValue(principal, sessionId, input);
  }

  @Post(":sessionId/regions/inspect")
  inspectRegion(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(inspectPraxisRegionInputSchema))
    input: InspectPraxisRegionInput,
  ) {
    return this.sessions.inspectRegion(principal, sessionId, input);
  }

  @Post(":sessionId/resources/inspect")
  inspectBrowserResources(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(inspectPraxisBrowserResourcesInputSchema)) _input: object,
  ) {
    return this.sessions.inspectBrowserResources(principal, sessionId);
  }

  @Post(":sessionId/public-resources/read")
  readPublicResource(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(readPraxisPublicResourceInputSchema))
    input: ReadPraxisPublicResourceInput,
  ) {
    return this.sessions.readPublicResource(principal, sessionId, input);
  }

  @Post(":sessionId/reconcile-unknown")
  reconcileUnknown(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(reconcileAdaptiveOperationSchema))
    input: ReconcileAdaptiveOperationInput,
  ) {
    return this.sessions.reconcileUnknown(principal, sessionId, input);
  }

  @Post(":sessionId/close")
  close(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(closeAdaptiveSessionSchema)) input: CloseAdaptiveSessionInput,
  ) {
    return this.sessions.close(principal, sessionId, input.idempotencyKey);
  }
}
