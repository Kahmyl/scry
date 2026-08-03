import { Module } from "@nestjs/common";

import { AccessModule } from "../access/index.js";
import { InfrastructureModule } from "../infrastructure/index.js";
import { VeilPreferencesController } from "./preferences.controller.js";
import { VeilPreferencesService } from "./preferences.service.js";

@Module({
  imports: [InfrastructureModule, AccessModule],
  controllers: [VeilPreferencesController],
  providers: [VeilPreferencesService],
  exports: [VeilPreferencesService],
})
export class VeilModule {}
