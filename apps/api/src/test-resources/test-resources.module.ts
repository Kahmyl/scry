import { Module } from "@nestjs/common";
import { BrowserExecutionModule } from "../browser-execution/browser-execution.module.js";
import { TestResourceProviders } from "./providers.js";
import { TestResourcesRepository } from "./test-resources.repository.js";
import { TestResourcesService } from "./test-resources.service.js";
import { TestResourcesController } from "./test-resources.controller.js";

@Module({
  imports: [BrowserExecutionModule],
  controllers: [TestResourcesController],
  providers: [TestResourceProviders, TestResourcesRepository, TestResourcesService],
})
export class TestResourcesModule {}
