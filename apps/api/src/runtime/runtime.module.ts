import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { ExecutionRepository } from "./repositories/execution.repository.js";
import { ReleaseAdmissionService } from "./services/release-admission.service.js";
import { RunQueueService } from "./services/run-queue.service.js";

@Module({
  imports: [InfrastructureModule],
  providers: [ExecutionRepository, RunQueueService, ReleaseAdmissionService],
  exports: [ExecutionRepository, RunQueueService, ReleaseAdmissionService],
})
export class RuntimeModule {}
