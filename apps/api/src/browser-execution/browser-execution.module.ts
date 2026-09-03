import { Module } from "@nestjs/common";

import { Database } from "../infrastructure/database.js";
import { RedisConnection } from "../infrastructure/redis.js";
import { BrowserExecutionRepository } from "./repositories/browser-execution.repository.js";
import { BrowserExecutionQueueService } from "./browser-execution-queue.service.js";
import { BrowserLifecycleController } from "./controllers/browser-lifecycle.controller.js";
import { BrowserLifecycleRepository } from "./repositories/browser-lifecycle.repository.js";
import { BrowserCommandRepository } from "./repositories/browser-command.repository.js";
import { BrowserProtectedValueCipher } from "./protected-value-cipher.js";
import { BrowserProjectController } from "./controllers/browser-project.controller.js";
import { BrowserProjectRepository } from "./repositories/browser-project.repository.js";
import { BrowserDashboardController } from "./controllers/browser-dashboard.controller.js";
import { BrowserDashboardRepository } from "./repositories/browser-dashboard.repository.js";

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
