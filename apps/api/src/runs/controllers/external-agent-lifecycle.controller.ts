import { Body, Controller, ForbiddenException, Inject, Param, Post } from "@nestjs/common";
import {
  adoptLegacyExternalAgentSessionSchema,
  terminateExternalAgentRunSchema,
  type AdoptLegacyExternalAgentSessionInput,
  type TerminateExternalAgentRunInput,
} from "@scry/contracts";

import { CurrentPrincipal, type Principal } from "../../auth/index.js";
import { ZodValidationPipe } from "../../common/validation.pipe.js";
import { ExternalAgentLifecycleService } from "../services/external-agent-lifecycle.service.js";

@Controller("api/external-agent-runs")
export class ExternalAgentLifecycleController {
  constructor(
    @Inject(ExternalAgentLifecycleService)
    private readonly lifecycle: ExternalAgentLifecycleService,
  ) {}

  @Post(":externalRunId/heartbeat")
  heartbeat(
    @Param("externalRunId") externalRunId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.lifecycle.heartbeat(principal, externalRunId);
  }

  @Post(":externalRunId/terminate")
  terminate(
    @Param("externalRunId") externalRunId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(terminateExternalAgentRunSchema))
    input: TerminateExternalAgentRunInput,
  ) {
    return this.lifecycle.terminate(principal, externalRunId, input);
  }
}

@Controller("api/agent-sessions")
export class LegacyExternalAgentLifecycleController {
  constructor(
    @Inject(ExternalAgentLifecycleService)
    private readonly lifecycle: ExternalAgentLifecycleService,
  ) {}

  @Post(":agentSessionId/external-owner-termination")
  terminate(
    @Param("agentSessionId") agentSessionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(adoptLegacyExternalAgentSessionSchema))
    input: AdoptLegacyExternalAgentSessionInput,
  ) {
    if (principal.kind !== "service")
      throw new ForbiddenException("Legacy lifecycle settlement requires service authentication");
    return this.lifecycle.adoptAndTerminateLegacySession(agentSessionId, input);
  }
}
