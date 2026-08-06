import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { PraxisModule } from "../praxis/index.js";
import { AuthenticationAuthoringService } from "./authentication-authoring.service.js";
import { AuthenticationAttemptRepository } from "./repositories/authentication-attempt.repository.js";

@Module({
  imports: [InfrastructureModule, PraxisModule],
  providers: [AuthenticationAuthoringService, AuthenticationAttemptRepository],
  exports: [AuthenticationAuthoringService, AuthenticationAttemptRepository],
})
export class AuthenticationAuthoringModule {}
