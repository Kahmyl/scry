import { Module } from "@nestjs/common";

import { AccessModule } from "./access/index.js";
import { ArtifactsModule } from "./artifacts/index.js";
import { AuthModule } from "./auth/index.js";
import { AuthoringModule } from "./authoring/index.js";
import { CalibrationModule } from "./calibration/index.js";
import { FlowsModule } from "./flows/index.js";
import { InfrastructureModule } from "./infrastructure/index.js";
import { MissionsModule } from "./missions/index.js";
import { OrchestrationModule } from "./orchestration/index.js";
import { PraxisModule } from "./praxis/index.js";
import { RuntimeModule } from "./runtime/index.js";
import { RunsModule } from "./runs/index.js";
import { SystemModule } from "./system/index.js";
import { VeilModule } from "./veil/index.js";

@Module({
  imports: [
    InfrastructureModule,
    AuthModule,
    SystemModule,
    AccessModule,
    ArtifactsModule,
    AuthoringModule,
    CalibrationModule,
    FlowsModule,
    MissionsModule,
    OrchestrationModule,
    PraxisModule,
    RuntimeModule,
    RunsModule,
    VeilModule,
  ],
  exports: [InfrastructureModule, AccessModule, RuntimeModule, CalibrationModule],
})
export class AppModule {}
