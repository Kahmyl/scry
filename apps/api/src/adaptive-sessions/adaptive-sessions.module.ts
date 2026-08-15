import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { PraxisSessionController } from "./adaptive-session.controller.js";
import { AdaptiveSessionKernelRunner } from "./adaptive-session-kernel.runner.js";
import { AdaptiveSessionRepository } from "./adaptive-session.repository.js";
import { MissionFlowAuthoringService } from "./mission-flow-authoring.service.js";
import { AdaptiveOperationReconciliationRegistry } from "./adaptive-operation-reconciliation.registry.js";
import { OperationBoundProtectedInputRepository } from "./operation-bound-protected-input.repository.js";
import { MissionProtectedQualificationRunner } from "./mission-protected-qualification.runner.js";

@Module({
  imports: [InfrastructureModule, RuntimeModule],
  controllers: [PraxisSessionController],
  providers: [AdaptiveSessionRepository, AdaptiveSessionKernelRunner, AdaptiveOperationReconciliationRegistry, MissionFlowAuthoringService, OperationBoundProtectedInputRepository, MissionProtectedQualificationRunner],
  exports: [AdaptiveSessionRepository, AdaptiveSessionKernelRunner, AdaptiveOperationReconciliationRegistry, MissionFlowAuthoringService, OperationBoundProtectedInputRepository, MissionProtectedQualificationRunner],
})
export class AdaptiveSessionsModule {}
