import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { ExecutionRepository } from "./repositories/execution.repository.js";
import { ExecutionKernelRepository } from "./repositories/execution-kernel.repository.js";
import { ProtectedOperationRepository } from "./repositories/protected-operation.repository.js";
import { ProtectedOutputPersistenceRepository } from "./repositories/protected-output-persistence.repository.js";
import { ExternalResourceBindingRepository } from "./repositories/external-resource-binding.repository.js";
import { ExternalResourcePresentationAuthorityRepository } from "./repositories/external-resource-presentation-authority.repository.js";
import {
  ExecutionCapabilityFactory,
  ExecutionKernelService,
} from "./services/execution-kernel.service.js";
import { ReleaseAdmissionService } from "./services/release-admission.service.js";
import { RunQueueService } from "./services/run-queue.service.js";
import { NativeBrowserDriver } from "./native-browser-driver/index.js";
import { ExternalResourceDestructiveTargetPreparationService } from "./services/external-resource-destructive-target-preparation.service.js";
import { ExternalResourceCredentialLifecycleService } from "./services/external-resource-credential-lifecycle.service.js";

@Module({
  imports: [InfrastructureModule],
  providers: [
    ExecutionRepository,
    ExecutionKernelRepository,
    ProtectedOperationRepository,
    ProtectedOutputPersistenceRepository,
    ExternalResourceBindingRepository,
    ExternalResourcePresentationAuthorityRepository,
    ExternalResourceDestructiveTargetPreparationService,
    ExternalResourceCredentialLifecycleService,
    ExecutionCapabilityFactory,
    ExecutionKernelService,
    RunQueueService,
    ReleaseAdmissionService,
    NativeBrowserDriver,
  ],
  exports: [
    ExecutionRepository,
    ExecutionKernelRepository,
    ProtectedOperationRepository,
    ProtectedOutputPersistenceRepository,
    ExternalResourceBindingRepository,
    ExternalResourcePresentationAuthorityRepository,
    ExternalResourceDestructiveTargetPreparationService,
    ExternalResourceCredentialLifecycleService,
    ExecutionCapabilityFactory,
    ExecutionKernelService,
    RunQueueService,
    ReleaseAdmissionService,
    NativeBrowserDriver,
  ],
})
export class RuntimeModule {}
