import { Module } from "@nestjs/common";

import { AdaptiveSessionsModule } from "../adaptive-sessions/index.js";
import { InfrastructureModule } from "../infrastructure/index.js";
import {
  ExternalAgentLifecycleController,
  LegacyExternalAgentLifecycleController,
} from "../runs/controllers/external-agent-lifecycle.controller.js";
import { ExternalAgentLifecycleService } from "../runs/services/external-agent-lifecycle.service.js";

@Module({
  imports: [InfrastructureModule, AdaptiveSessionsModule],
  controllers: [ExternalAgentLifecycleController, LegacyExternalAgentLifecycleController],
  providers: [ExternalAgentLifecycleService],
  exports: [ExternalAgentLifecycleService],
})
export class ExternalAgentsModule {}
