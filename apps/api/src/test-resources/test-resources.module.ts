import { Module } from "@nestjs/common";
import { BrowserExecutionModule } from "../browser-execution/browser-execution.module.js";
import { TestResourceProviders } from "./providers.js";
import { TestResourcesRepository } from "./test-resources.repository.js";
import { TestResourcesService } from "./test-resources.service.js";
import { TestResourcesController } from "./test-resources.controller.js";
import { TestingContextController } from "./testing-context.controller.js";
import { CleanupService } from "./cleanup.service.js";

@Module({
  imports: [BrowserExecutionModule],
  controllers: [TestResourcesController, TestingContextController],
  providers: [TestResourceProviders, TestResourcesRepository, TestResourcesService, CleanupService],
})
export class TestResourcesModule {}
