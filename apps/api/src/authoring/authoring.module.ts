import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { AuthoringController } from "./authoring.controller.js";
import { AuthoringRuntimeRepository } from "./repositories/authoring-runtime.repository.js";
import { AuthoringService } from "./authoring.service.js";

@Module({
  imports: [InfrastructureModule, RuntimeModule],
  controllers: [AuthoringController],
  providers: [AuthoringService, AuthoringRuntimeRepository],
  exports: [AuthoringService, AuthoringRuntimeRepository],
})
export class AuthoringModule {}
