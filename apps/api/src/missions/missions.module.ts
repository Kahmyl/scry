import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { OrchestrationModule } from "../orchestration/index.js";
import { MissionController } from "./mission.controller.js";
import { MissionService } from "./mission.service.js";

@Module({
  imports: [InfrastructureModule, OrchestrationModule],
  controllers: [MissionController],
  providers: [MissionService],
  exports: [MissionService],
})
export class MissionsModule {}
