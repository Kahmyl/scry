import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { CalibrationController } from "./calibration.controller.js";
import { CalibrationRuntimeRepository } from "./repositories/calibration-runtime.repository.js";
import { CalibrationService } from "./calibration.service.js";
import { ProbeRuntimeRepository } from "./repositories/probe-runtime.repository.js";

@Module({
  imports: [InfrastructureModule, RuntimeModule],
  controllers: [CalibrationController],
  providers: [CalibrationService, CalibrationRuntimeRepository, ProbeRuntimeRepository],
  exports: [CalibrationService, CalibrationRuntimeRepository, ProbeRuntimeRepository],
})
export class CalibrationModule {}
