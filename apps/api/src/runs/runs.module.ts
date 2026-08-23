import { Module } from "@nestjs/common";

import { AccessModule } from "../access/index.js";
import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { AdaptiveSessionsModule } from "../adaptive-sessions/index.js";
import { AgentDirectedRunService } from "./services/agent-directed-run.service.js";
import { RunObservationService } from "./services/run-observation.service.js";
import { RunsController } from "./controllers/runs.controller.js";
import {
  ExternalAgentLifecycleController,
  LegacyExternalAgentLifecycleController,
} from "./controllers/external-agent-lifecycle.controller.js";
import { ExternalAgentLifecycleService } from "./services/external-agent-lifecycle.service.js";

@Module({
  imports: [InfrastructureModule, AccessModule, RuntimeModule, AdaptiveSessionsModule],
  controllers: [
    RunsController,
    ExternalAgentLifecycleController,
    LegacyExternalAgentLifecycleController,
  ],
  providers: [RunObservationService, AgentDirectedRunService, ExternalAgentLifecycleService],
  exports: [RunObservationService, ExternalAgentLifecycleService],
})
export class RunsModule {}
