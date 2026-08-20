import { Module } from "@nestjs/common";

import { AccessModule } from "../access/index.js";
import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { AdaptiveSessionsModule } from "../adaptive-sessions/index.js";
import { AgentDirectedRunService } from "./services/agent-directed-run.service.js";
import { RunObservationService } from "./services/run-observation.service.js";
import { RunsController } from "./runs.controller.js";

@Module({
  imports: [InfrastructureModule, AccessModule, RuntimeModule, AdaptiveSessionsModule],
  controllers: [RunsController],
  providers: [RunObservationService, AgentDirectedRunService],
  exports: [RunObservationService],
})
export class RunsModule {}
