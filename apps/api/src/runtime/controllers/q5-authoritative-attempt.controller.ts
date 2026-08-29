import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { createHash } from "node:crypto";

import { CurrentPrincipal, type Principal } from "../../auth/index.js";
import { Q5AuthoritativeAttemptRepository } from "../repositories/q5-authoritative-attempt.repository.js";

@Controller("api/internal/q5-authoritative-attempts")
export class Q5AuthoritativeAttemptController {
  constructor(
    @Inject(Q5AuthoritativeAttemptRepository)
    private readonly attempts: Q5AuthoritativeAttemptRepository,
  ) {}

  @Post("scope")
  scope(
    @CurrentPrincipal() principal: Principal,
    @Body() input: { credential: string; externalRunId: string },
  ) {
    requireService(principal);
    return this.attempts.scopeForCredential(digest(input.credential), input.externalRunId);
  }

  @Post(":attemptId/consume")
  consume(
    @CurrentPrincipal() principal: Principal,
    @Param("attemptId") attemptId: string,
    @Body() input: { credential: string },
  ) {
    requireService(principal);
    return this.attempts.consume(attemptId, digest(input.credential));
  }

  @Post(":attemptId/provider-requests")
  providerRequest(@CurrentPrincipal() principal: Principal, @Param("attemptId") attemptId: string) {
    requireService(principal);
    return this.attempts.recordProviderRequest(attemptId);
  }

  @Post(":attemptId/runtime-bindings")
  bindRuntime(
    @CurrentPrincipal() principal: Principal,
    @Param("attemptId") attemptId: string,
    @Body() input: { runId?: string; praxisSessionId?: string },
  ) {
    requireService(principal);
    return this.attempts.bindRuntime(attemptId, input);
  }

  @Patch(":attemptId/terminal-state")
  settle(
    @CurrentPrincipal() principal: Principal,
    @Param("attemptId") attemptId: string,
    @Body()
    input: {
      state: "succeeded" | "failed" | "inconclusive" | "cancelled";
      evidenceManifestDigest?: string;
    },
  ) {
    requireService(principal);
    if (!["succeeded", "failed", "inconclusive", "cancelled"].includes(input.state))
      throw new ForbiddenException({ code: "Q5_TERMINAL_STATE_INVALID" });
    return this.attempts.settle(attemptId, input.state, input.evidenceManifestDigest);
  }

  @Get(":attemptId/evidence-binding")
  evidenceBinding(@CurrentPrincipal() principal: Principal, @Param("attemptId") attemptId: string) {
    requireService(principal);
    return this.attempts.evidenceBinding(attemptId);
  }
}

function requireService(principal: Principal) {
  if (principal.kind !== "service") throw new ForbiddenException({ code: "Q5_INTERNAL_ONLY" });
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
