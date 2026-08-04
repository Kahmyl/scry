import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { OrchestrationService } from "./orchestration.service.js";

@Module({
  imports: [InfrastructureModule],
  providers: [OrchestrationService],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}
