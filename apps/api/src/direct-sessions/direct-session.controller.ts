import { Body, Controller, Delete, Get, Inject, Param, Post } from "@nestjs/common";
import { executeDirectTurnSchema, startDirectSessionSchema, type ExecuteDirectTurnInput, type StartDirectSessionInput } from "@scry/contracts";
import { CurrentPrincipal, type Principal } from "../auth/index.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";
import { DirectSessionService } from "./direct-session.service.js";

@Controller("api/direct-sessions")
export class DirectSessionController {
  constructor(@Inject(DirectSessionService) private readonly sessions: DirectSessionService) {}
  @Post() start(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(startDirectSessionSchema)) input: StartDirectSessionInput) { return this.sessions.start(principal, input); }
  @Post(":sessionId/turns") turn(@CurrentPrincipal() principal: Principal, @Param("sessionId") sessionId: string, @Body(new ZodValidationPipe(executeDirectTurnSchema)) input: ExecuteDirectTurnInput) { return this.sessions.turn(principal, sessionId, input); }
  @Get(":sessionId") observe(@CurrentPrincipal() principal: Principal, @Param("sessionId") sessionId: string) { return this.sessions.observe(principal, sessionId); }
  @Delete(":sessionId") close(@CurrentPrincipal() principal: Principal, @Param("sessionId") sessionId: string) { return this.sessions.close(principal, sessionId); }
}
