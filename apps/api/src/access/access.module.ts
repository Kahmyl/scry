import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { CredentialsController } from "./controllers/credentials.controller.js";
import { EnvironmentsController } from "./controllers/environments.controller.js";
import { ProjectsController } from "./controllers/projects.controller.js";
import { ScryRepository } from "./repositories/scry.repository.js";

@Module({
  imports: [InfrastructureModule],
  controllers: [ProjectsController, EnvironmentsController, CredentialsController],
  providers: [ScryRepository],
  exports: [ScryRepository],
})
export class AccessModule {}
