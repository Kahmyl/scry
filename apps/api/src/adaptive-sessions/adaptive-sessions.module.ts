import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { AdaptiveSessionController } from "./adaptive-session.controller.js";
import { AdaptiveSessionKernelRunner } from "./adaptive-session-kernel.runner.js";
import { AdaptiveSessionRepository } from "./adaptive-session.repository.js";
import { AdaptiveSessionService } from "./adaptive-session.service.js";

@Module({
  imports: [InfrastructureModule, RuntimeModule],
  controllers: [AdaptiveSessionController],
  providers: [AdaptiveSessionRepository, AdaptiveSessionKernelRunner, AdaptiveSessionService],
  exports: [AdaptiveSessionRepository, AdaptiveSessionKernelRunner, AdaptiveSessionService],
})
export class AdaptiveSessionsModule {}
