import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { AuthoringController } from "./authoring.controller.js";
import { AuthoringRuntimeCommandService } from "./authoring-runtime-command.service.js";
import { AuthoringService } from "./authoring.service.js";
import { AuthoringRuntimeCommandRepository } from "./repositories/authoring-runtime-command.repository.js";
import { AuthoringRuntimeRepository } from "./repositories/authoring-runtime.repository.js";

@Module({
  imports: [InfrastructureModule, RuntimeModule],
  controllers: [AuthoringController],
  providers: [
    AuthoringService,
    AuthoringRuntimeCommandService,
    AuthoringRuntimeRepository,
    AuthoringRuntimeCommandRepository,
  ],
  exports: [
    AuthoringService,
    AuthoringRuntimeCommandService,
    AuthoringRuntimeRepository,
    AuthoringRuntimeCommandRepository,
  ],
})
export class AuthoringModule {}
