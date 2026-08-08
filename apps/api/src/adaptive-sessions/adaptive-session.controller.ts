import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import {
  adaptiveSessionTransitionSchema,
  advanceAdaptiveSessionSchema,
  startAdaptiveSessionSchema,
  type AdaptiveSessionTransitionInput,
  type AdvanceAdaptiveSessionInput,
  type StartAdaptiveSessionInput,
} from "@scry/contracts";

import { CurrentPrincipal, type Principal } from "../auth/index.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";
import { AdaptiveSessionService } from "./adaptive-session.service.js";

@Controller("api/adaptive-sessions")
export class AdaptiveSessionController {
  constructor(@Inject(AdaptiveSessionService) private readonly sessions: AdaptiveSessionService) {}

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

  @Post(":sessionId/advance")
  advance(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(advanceAdaptiveSessionSchema)) input: AdvanceAdaptiveSessionInput,
  ) {
    return this.sessions.advance(principal, sessionId, input);
  }

  @Post(":sessionId/suspend")
  suspend(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(adaptiveSessionTransitionSchema))
    input: AdaptiveSessionTransitionInput,
  ) {
    return this.sessions.suspend(principal, sessionId, input);
  }

  @Post(":sessionId/resume")
  resume(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(adaptiveSessionTransitionSchema))
    input: AdaptiveSessionTransitionInput,
  ) {
    return this.sessions.resume(principal, sessionId, input);
  }

  @Post(":sessionId/cancel")
  cancel(
    @CurrentPrincipal() principal: Principal,
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(adaptiveSessionTransitionSchema))
    input: AdaptiveSessionTransitionInput,
  ) {
    return this.sessions.cancel(principal, sessionId, input);
  }
}
