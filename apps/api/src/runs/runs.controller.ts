import { Body, ConflictException, Controller, Get, Inject, Param, Post } from "@nestjs/common";
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
import { ReleaseAdmissionService, RunQueueService } from "../runtime/index.js";
import { RunObservationService } from "./run-observation.service.js";
import { AgentDirectedRunService } from "./agent-directed-run.service.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";

@Controller("api/runs")
export class RunsController {
  constructor(
    @Inject(ScryRepository) private readonly repository: ScryRepository,
    @Inject(RunQueueService) private readonly queue: RunQueueService,
    @Inject(RunObservationService) private readonly observations: RunObservationService,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
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
    @Body(new ZodValidationPipe(finalizeAgentDirectedRunSchema)) input: FinalizeAgentDirectedRunInput,
  ) {
    return this.agentRuns.finalize(principal, runId, input);
  }

  @Get(":runId/veil")
  async getVeil(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return (await this.observations.observe(principal, runId)).veil;
  }

  @Post(":runId/start")
  async start(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    await this.admission.assertAcceptingWork();
    this.repository.requireWriteAccess(principal);
    const run = await this.repository.getRun(principal, runId) as { executionSnapshot?: { executionModel?: string } };
    if (run.executionSnapshot?.executionModel === "agent_directed_v1")
      throw new ConflictException({ code: "AGENT_DIRECTED_RUN_REQUIRES_EXPLICIT_OPERATION" });
    await this.repository.validateRunCredentials(principal, runId);
    return this.queue.start(runId);
  }

  @Post(":runId/cancel")
  async cancel(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    this.repository.requireWriteAccess(principal);
    await this.repository.getRun(principal, runId);
    return this.queue.cancel(runId);
  }

  @Post(":runId/rerun")
  async rerun(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    await this.admission.assertAcceptingWork();
    const source = await this.repository.getRun(principal, runId) as { executionSnapshot?: { executionModel?: string } };
    if (source.executionSnapshot?.executionModel === "agent_directed_v1")
      throw new ConflictException({ code: "AGENT_DIRECTED_RUN_REQUIRES_NEW_SESSION_BINDING" });
    const run = await this.repository.rerunExact(principal, runId);
    await this.queue.dispatchPending();
    return run;
  }
}
