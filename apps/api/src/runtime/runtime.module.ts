import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { ExecutionRepository } from "./repositories/execution.repository.js";
import { ExecutionKernelRepository } from "./repositories/execution-kernel.repository.js";
import {
  ExecutionCapabilityFactory,
  ExecutionKernelService,
} from "./services/execution-kernel.service.js";
import { ReleaseAdmissionService } from "./services/release-admission.service.js";
import { RunQueueService } from "./services/run-queue.service.js";
import { NativeBrowserDriver } from "./native-browser-driver/index.js";

@Module({
  imports: [InfrastructureModule],
  providers: [
    ExecutionRepository,
    ExecutionKernelRepository,
    ExecutionCapabilityFactory,
    ExecutionKernelService,
    RunQueueService,
    ReleaseAdmissionService,
    NativeBrowserDriver,
  ],
  exports: [
    ExecutionRepository,
    ExecutionKernelRepository,
    ExecutionCapabilityFactory,
    ExecutionKernelService,
    RunQueueService,
    ReleaseAdmissionService,
    NativeBrowserDriver,
  ],
})
export class RuntimeModule {}
