import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { PraxisService } from "./praxis.service.js";
import { PraxisController } from "./praxis.controller.js";
import { PraxisRuntimeRepository } from "./repositories/praxis-runtime.repository.js";

@Module({
  imports: [InfrastructureModule, RuntimeModule],
  controllers: [PraxisController],
  providers: [PraxisService, PraxisRuntimeRepository],
  exports: [PraxisService, PraxisRuntimeRepository],
})
export class PraxisModule {}
