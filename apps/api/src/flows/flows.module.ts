import { Module } from "@nestjs/common";

import { InfrastructureModule } from "../infrastructure/index.js";
import { RuntimeModule } from "../runtime/index.js";
import { FlowController } from "./flow.controller.js";
import { FlowReadRepository } from "./flow-read.repository.js";
import { FlowService } from "./flow.service.js";

@Module({
  imports: [InfrastructureModule, RuntimeModule],
  controllers: [FlowController],
  providers: [FlowService, FlowReadRepository],
  exports: [FlowService, FlowReadRepository],
})
export class FlowsModule {}
