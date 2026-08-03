import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import {
  cancelCalibrationSchema,
  decideCalibrationSchema,
  requestCalibrationSchema,
  retryCalibrationSchema,
  type CancelCalibrationInput,
  type DecideCalibrationInput,
  type RequestCalibrationInput,
  type RetryCalibrationInput,
} from "@scry/contracts";

import { CalibrationService } from "./calibration.service.js";
import { CurrentPrincipal, type Principal } from "../auth/index.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";

@Controller("api")
export class CalibrationController {
  constructor(@Inject(CalibrationService) private readonly service: CalibrationService) {}

  @Post("projects/:projectId/calibration-sessions")
  request(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(requestCalibrationSchema)) input: RequestCalibrationInput,
  ) {
    return this.service.request(principal, projectId, input);
  }
  @Get("projects/:projectId/calibrations") list(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.service.list(principal, projectId);
  }
  @Get("calibrations/:calibrationId") get(
    @Param("calibrationId") calibrationId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.service.get(principal, calibrationId);
  }
  @Post("calibrations/:calibrationId/attestations/:attestationId/approve")
  approve(
    @Param("calibrationId") calibrationId: string,
    @Param("attestationId") attestationId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(decideCalibrationSchema)) input: DecideCalibrationInput,
  ) {
    return this.service.decide(principal, calibrationId, attestationId, "approved", input);
  }
  @Post("calibrations/:calibrationId/attestations/:attestationId/reject")
  reject(
    @Param("calibrationId") calibrationId: string,
    @Param("attestationId") attestationId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(decideCalibrationSchema)) input: DecideCalibrationInput,
  ) {
    return this.service.decide(principal, calibrationId, attestationId, "rejected", input);
  }
  @Post("calibration-sessions/:sessionId/retry") retry(
    @Param("sessionId") sessionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(retryCalibrationSchema)) input: RetryCalibrationInput,
  ) {
    return this.service.retry(principal, sessionId, input);
  }
  @Post("calibration-sessions/:sessionId/cancel") cancel(
    @Param("sessionId") sessionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(cancelCalibrationSchema)) input: CancelCalibrationInput,
  ) {
    return this.service.cancel(principal, sessionId, input);
  }
}
