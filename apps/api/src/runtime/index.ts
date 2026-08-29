export {
  classifyOriginalAfterConfirmation,
  ExecutionRepository,
} from "./repositories/execution.repository.js";

export {
  ReleaseAdmissionService,
  type ReleaseAdmissionStatus,
} from "./services/release-admission.service.js";

export {
  CALIBRATION_QUEUE_NAME,
  PRAXIS_QUEUE_NAME,
  PROBE_QUEUE_NAME,
  RUN_QUEUE_NAME,
  RunQueueService,
  type CalibrationJob,
  type PraxisJob,
  type ProbeJob,
  type RunJob,
} from "./services/run-queue.service.js";

export { RuntimeModule } from "./runtime.module.js";
export * from "./native-browser-driver/index.js";
export { ExecutionKernelRepository } from "./repositories/execution-kernel.repository.js";
export { ProtectedOperationRepository } from "./repositories/protected-operation.repository.js";
export { ProtectedOutputPersistenceRepository } from "./repositories/protected-output-persistence.repository.js";
export { QualificationCampaignRepository } from "./repositories/qualification-campaign.repository.js";
export { Q5AuthoritativeAttemptRepository } from "./repositories/q5-authoritative-attempt.repository.js";
export { ExternalResourceBindingRepository } from "./repositories/external-resource-binding.repository.js";
export { ExternalResourcePresentationAuthorityRepository } from "./repositories/external-resource-presentation-authority.repository.js";
export { ExternalResourceDestructiveTargetPreparationService } from "./services/external-resource-destructive-target-preparation.service.js";
export { ExternalResourceCredentialLifecycleService } from "./services/external-resource-credential-lifecycle.service.js";
export {
  UnknownMutationAdministrationService,
  UNKNOWN_HISTORICAL_MUTATION_CLOSED_REASON,
} from "./services/unknown-mutation-administration.service.js";
export {
  ExecutionCapabilityFactory,
  ExecutionKernelService,
  observePraxisFailure,
  observeProtectedOperationResult,
} from "./services/execution-kernel.service.js";
