import { Body, Controller, Get, Inject, Param, Post, Query, Res } from "@nestjs/common";
import {
  createFlowRevisionSchema,
  createFlowSchema,
  createFlowRunSchema,
  validatePlanSchema,
  type CreateFlowRevisionInput,
  type CreateFlowInput,
  type CreateFlowRunInput,
  type ValidatePlanInput,
  bindCalibrationSchema,
  type BindCalibrationInput,
} from "@scry/contracts";

import { CurrentPrincipal, Public, type Principal } from "../auth/index.js";
import { FlowService } from "./flow.service.js";
import { RunQueueService } from "../runtime/index.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";

@Controller("api")
export class FlowController {
  constructor(
    @Inject(FlowService) private readonly core: FlowService,
    @Inject(RunQueueService) private readonly queue: RunQueueService,
  ) {}

  @Get("capabilities")
  @Public()
  capabilities() {
    return this.core.capabilities();
  }

  @Get("ready")
  @Public()
  async readiness(@Res({ passthrough: true }) reply: { status(code: number): unknown }) {
    const status = await this.core.readiness();
    if (!status.ready) reply.status(503);
    return status;
  }

  @Post("plan-validations")
  validate(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(validatePlanSchema)) input: ValidatePlanInput,
  ) {
    return this.core.validate(principal, input);
  }

  @Post("projects/:projectId/flows")
  createFlow(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createFlowSchema)) input: CreateFlowInput,
  ) {
    return this.core.createFlow(principal, projectId, input);
  }

  @Get("projects/:projectId/flows")
  listFlows(
    @Param("projectId") projectId: string,
    @Query("visibility") visibility: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.core.listFlows(principal, projectId, visibility ?? "reusable");
  }

  @Post("flows/:flowId/revisions")
  reviseFlow(
    @Param("flowId") flowId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createFlowRevisionSchema)) input: CreateFlowRevisionInput,
  ) {
    return this.core.reviseFlow(principal, flowId, input);
  }

  @Post("flows/:flowId/calibration-bindings")
  bindCalibration(
    @Param("flowId") flowId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(bindCalibrationSchema)) input: BindCalibrationInput,
  ) {
    return this.core.bindCalibration(principal, flowId, input);
  }

  @Post("projects/:projectId/runs")
  async createRun(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createFlowRunSchema)) input: CreateFlowRunInput,
  ) {
    const run = await this.core.createRun(principal, projectId, input);
    await this.queue.dispatchPending();
    return run;
  }
}
