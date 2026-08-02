import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import {
  HealthController,
  ProjectsController,
  RunsController,
  EnvironmentsController,
  CredentialsController,
  McpTokensController,
} from "./controllers.js";
import { Database } from "./database.js";
import { ExecutionRepository } from "./execution.repository.js";
import { RedisConnection } from "./redis.js";
import { ScryRepository } from "./repository.js";
import { RunQueueService } from "./queue.service.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { IdentityRepository } from "./identity.repository.js";
import { McpTokenRepository } from "./mcp-token.repository.js";
import { FlowController } from "./flow.controller.js";
import { FlowService } from "./flow.service.js";
import { ArtifactController } from "./artifact.controller.js";
import { ArtifactService } from "./artifact.service.js";
import { CalibrationController } from "./calibration.controller.js";
import { CalibrationService } from "./calibration.service.js";
import { CalibrationRuntimeRepository } from "./calibration-runtime.repository.js";
import { RunObservationService } from "./run-observation.service.js";
import { ReleaseAdmissionService } from "./release-admission.service.js";
import { MissionController } from "./mission.controller.js";
import { MissionService } from "./mission.service.js";
import { OrchestrationService } from "./orchestration.service.js";
import { GroundingController } from "./grounding.controller.js";
import { GroundingService } from "./grounding.service.js";
import { AuthoringController } from "./authoring.controller.js";
import { AuthoringService } from "./authoring.service.js";
import { ProbeRuntimeRepository } from "./probe-runtime.repository.js";

@Module({
  controllers: [
    HealthController,
    ProjectsController,
    EnvironmentsController,
    CredentialsController,
    RunsController,
    McpTokensController,
    FlowController,
    ArtifactController,
    CalibrationController,
    MissionController,
    GroundingController,
    AuthoringController,
  ],
  providers: [
    Database,
    RedisConnection,
    ScryRepository,
    ExecutionRepository,
    RunQueueService,
    IdentityRepository,
    AuthService,
    McpTokenRepository,
    FlowService,
    ArtifactService,
    CalibrationService,
    CalibrationRuntimeRepository,
    RunObservationService,
    ReleaseAdmissionService,
    MissionService,
    OrchestrationService,
    GroundingService,
    AuthoringService,
    ProbeRuntimeRepository,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [
    Database,
    RedisConnection,
    ScryRepository,
    ExecutionRepository,
    RunQueueService,
    CalibrationRuntimeRepository,
  ],
})
export class AppModule {}
