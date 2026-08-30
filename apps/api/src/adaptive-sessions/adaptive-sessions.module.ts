import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { PraxisSessionController } from "./adaptive-session.controller.js";
import { AdaptiveSessionKernelRunner } from "./adaptive-session-kernel.runner.js";
import { AdaptiveSessionRepository } from "./repositories/adaptive-session.repository.js";
import { MissionFlowAuthoringService } from "./mission-flow-authoring.service.js";
import { AdaptiveOperationReconciliationRegistry } from "./adaptive-operation-reconciliation.registry.js";
import { OperationBoundProtectedInputRepository } from "./repositories/operation-bound-protected-input.repository.js";
import { MissionProtectedQualificationRunner } from "./mission-protected-qualification.runner.js";
import { VitractCredentialResourceEffectProvider } from "./vitract-credential-resource-effect.provider.js";
import { PreparedProtectedOperationRepository } from "./repositories/prepared-protected-operation.repository.js";
import { VitractObservedOperationContractProvider } from "./vitract-observed-operation-contract.provider.js";

@Module({
  imports: [InfrastructureModule, RuntimeModule],
  controllers: [PraxisSessionController],
  providers: [
    AdaptiveSessionRepository,
    AdaptiveSessionKernelRunner,
    AdaptiveOperationReconciliationRegistry,
    VitractCredentialResourceEffectProvider,
    MissionFlowAuthoringService,
    OperationBoundProtectedInputRepository,
    MissionProtectedQualificationRunner,
    PreparedProtectedOperationRepository,
    VitractObservedOperationContractProvider,
  ],
  exports: [
    AdaptiveSessionRepository,
    AdaptiveSessionKernelRunner,
    AdaptiveOperationReconciliationRegistry,
    MissionFlowAuthoringService,
    OperationBoundProtectedInputRepository,
    MissionProtectedQualificationRunner,
    PreparedProtectedOperationRepository,
    VitractObservedOperationContractProvider,
  ],
})
export class AdaptiveSessionsModule {}
