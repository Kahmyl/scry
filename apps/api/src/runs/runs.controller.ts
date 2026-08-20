import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import {
  attachRunPraxisSessionSchema,
  dispatchRunOperationSchema,
  finalizeAgentDirectedRunSchema,
  type AttachRunPraxisSessionInput,
  type DispatchRunOperationInput,
  type FinalizeAgentDirectedRunInput,
} from "@scry/contracts";

import { ScryRepository } from "../access/index.js";
import { CurrentPrincipal, type Principal } from "../auth/index.js";
import { RunQueueService } from "../runtime/index.js";
import { RunObservationService } from "./services/run-observation.service.js";
import { AgentDirectedRunService } from "./services/agent-directed-run.service.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";

@Controller("api/runs")
export class RunsController {
  constructor(
    @Inject(ScryRepository) private readonly repository: ScryRepository,
    @Inject(RunQueueService) private readonly queue: RunQueueService,
    @Inject(RunObservationService) private readonly observations: RunObservationService,
    @Inject(AgentDirectedRunService) private readonly agentRuns: AgentDirectedRunService,
  ) {}

  @Get(":runId")
  get(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return this.observations.observe(principal, runId);
  }

  @Post(":runId/operations")
  dispatchOperation(
    @Param("runId") runId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(dispatchRunOperationSchema)) input: DispatchRunOperationInput,
  ) {
    return this.agentRuns.dispatch(principal, runId, input);
  }

  @Post(":runId/praxis-session")
  attachPraxisSession(
    @Param("runId") runId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(attachRunPraxisSessionSchema)) input: AttachRunPraxisSessionInput,
  ) {
    return this.agentRuns.attach(principal, runId, input);
  }

  @Post(":runId/finalize")
  finalize(
    @Param("runId") runId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(finalizeAgentDirectedRunSchema))
    input: FinalizeAgentDirectedRunInput,
  ) {
    return this.agentRuns.finalize(principal, runId, input);
  }

  @Get(":runId/veil")
  async getVeil(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return (await this.observations.observe(principal, runId)).veil;
  }

  @Post(":runId/cancel")
  async cancel(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    this.repository.requireWriteAccess(principal);
    await this.repository.getRun(principal, runId);
    return this.queue.cancel(runId);
  }
}
