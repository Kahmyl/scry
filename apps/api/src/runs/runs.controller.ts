import { Controller, Get, Inject, Param, Post } from "@nestjs/common";

import { ScryRepository } from "../access/index.js";
import { CurrentPrincipal, type Principal } from "../auth/index.js";
import { ReleaseAdmissionService, RunQueueService } from "../runtime/index.js";
import { RunObservationService } from "./run-observation.service.js";

@Controller("api/runs")
export class RunsController {
  constructor(
    @Inject(ScryRepository) private readonly repository: ScryRepository,
    @Inject(RunQueueService) private readonly queue: RunQueueService,
    @Inject(RunObservationService) private readonly observations: RunObservationService,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
  ) {}

  @Get(":runId")
  get(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return this.observations.observe(principal, runId);
  }

  @Get(":runId/veil")
  async getVeil(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    return (await this.observations.observe(principal, runId)).veil;
  }

  @Post(":runId/start")
  async start(@Param("runId") runId: string, @CurrentPrincipal() principal: Principal) {
    await this.admission.assertAcceptingWork();
    this.repository.requireWriteAccess(principal);
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
    const run = await this.repository.rerunExact(principal, runId);
    await this.queue.dispatchPending();
    return run;
  }
}
