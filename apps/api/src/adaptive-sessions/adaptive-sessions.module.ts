import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { AdaptiveSessionController } from "./adaptive-session.controller.js";
import { AdaptiveSessionKernelRunner } from "./adaptive-session-kernel.runner.js";
import { AdaptiveSessionRepository } from "./adaptive-session.repository.js";
import { MissionFlowAuthoringService } from "./mission-flow-authoring.service.js";

@Module({
  imports: [InfrastructureModule, RuntimeModule],
  controllers: [AdaptiveSessionController],
  providers: [AdaptiveSessionRepository, AdaptiveSessionKernelRunner, MissionFlowAuthoringService],
  exports: [AdaptiveSessionRepository, AdaptiveSessionKernelRunner, MissionFlowAuthoringService],
})
export class AdaptiveSessionsModule {}
