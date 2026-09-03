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
import { UnknownMutationAdministrationService } from "./services/unknown-mutation-administration.service.js";
import { QualificationCampaignRepository } from "./repositories/qualification-campaign.repository.js";
import { QualificationCampaignController } from "./controllers/qualification-campaign.controller.js";
import { Q5AuthoritativeAttemptRepository } from "./repositories/q5-authoritative-attempt.repository.js";
import { Q5AuthoritativeAttemptController } from "./controllers/q5-authoritative-attempt.controller.js";

@Module({
  imports: [InfrastructureModule],
  controllers: [QualificationCampaignController, Q5AuthoritativeAttemptController],
  providers: [
    ExecutionRepository,
    ExecutionKernelRepository,
    ProtectedOperationRepository,
    ProtectedOutputPersistenceRepository,
    ExternalResourceBindingRepository,
    ExternalResourcePresentationAuthorityRepository,
    ExternalResourceDestructiveTargetPreparationService,
    ExternalResourceCredentialLifecycleService,
    UnknownMutationAdministrationService,
    ExecutionCapabilityFactory,
    ExecutionKernelService,
    RunQueueService,
    ReleaseAdmissionService,
    NativeBrowserDriver,
    QualificationCampaignRepository,
    Q5AuthoritativeAttemptRepository,
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
    UnknownMutationAdministrationService,
    ExecutionCapabilityFactory,
    ExecutionKernelService,
    RunQueueService,
    ReleaseAdmissionService,
    NativeBrowserDriver,
    QualificationCampaignRepository,
    Q5AuthoritativeAttemptRepository,
  ],
})
export class RuntimeModule {}
