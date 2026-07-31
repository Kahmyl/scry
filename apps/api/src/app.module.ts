import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import {
  HealthController,
  ArtifactsController,
  PlansController,
  ProjectsController,
  RunsController,
  SpecificationsController,
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

@Module({
  controllers: [
    HealthController,
    ArtifactsController,
    ProjectsController,
    SpecificationsController,
    EnvironmentsController,
    CredentialsController,
    PlansController,
    RunsController,
    McpTokensController,
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
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [
    Database,
    RedisConnection,
    ScryRepository,
    ExecutionRepository,
    RunQueueService,
  ],
})
export class AppModule {}
