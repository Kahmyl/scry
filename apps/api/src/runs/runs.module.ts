import { Module } from "@nestjs/common";

import { AccessModule } from "../access/index.js";
import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { RunObservationService } from "./run-observation.service.js";
import { RunsController } from "./runs.controller.js";

@Module({
  imports: [InfrastructureModule, AccessModule, RuntimeModule],
  controllers: [RunsController],
  providers: [RunObservationService],
  exports: [RunObservationService],
})
export class RunsModule {}
