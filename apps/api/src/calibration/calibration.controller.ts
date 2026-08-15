import { Controller, Get, Inject, Param } from "@nestjs/common";

import { CalibrationService } from "./calibration.service.js";
import { CurrentPrincipal, type Principal } from "../auth/index.js";

@Controller("api")
export class CalibrationController {
  constructor(@Inject(CalibrationService) private readonly service: CalibrationService) {}

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
}
