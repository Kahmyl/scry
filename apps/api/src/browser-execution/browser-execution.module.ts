import { Module } from "@nestjs/common";

import { Database } from "../infrastructure/database.js";
import { RedisConnection } from "../infrastructure/redis.js";
import { BrowserExecutionRepository } from "./browser-execution.repository.js";
import { BrowserExecutionQueueService } from "./browser-execution-queue.service.js";
import { BrowserLifecycleController } from "./browser-lifecycle.controller.js";
import { BrowserLifecycleRepository } from "./browser-lifecycle.repository.js";
import { BrowserCommandRepository } from "./browser-command.repository.js";
import { BrowserProtectedValueCipher } from "./protected-value-cipher.js";
import { BrowserProjectController } from "./browser-project.controller.js";
import { BrowserProjectRepository } from "./browser-project.repository.js";
import { BrowserDashboardController } from "./browser-dashboard.controller.js";
import { BrowserDashboardRepository } from "./browser-dashboard.repository.js";

@Module({
  controllers: [BrowserLifecycleController, BrowserProjectController, BrowserDashboardController],
  providers: [
    Database,
    RedisConnection,
    BrowserProtectedValueCipher,
    BrowserExecutionRepository,
    BrowserCommandRepository,
    BrowserExecutionQueueService,
    BrowserLifecycleRepository,
    BrowserProjectRepository,
    BrowserDashboardRepository,
  ],
  exports: [
    Database,
    RedisConnection,
    BrowserProtectedValueCipher,
    BrowserExecutionRepository,
    BrowserCommandRepository,
    BrowserExecutionQueueService,
    BrowserLifecycleRepository,
    BrowserProjectRepository,
    BrowserDashboardRepository,
  ],
})
export class BrowserExecutionModule {}
