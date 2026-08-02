import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { protectedRecoveryCommandSchema, type ProtectedRecoveryCommand } from "@scry/contracts";
import type { Principal } from "./auth.types.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import { GroundingService } from "./grounding.service.js";
import { ZodValidationPipe } from "./validation.pipe.js";

@Controller("api")
export class GroundingController {
  constructor(@Inject(GroundingService) private readonly service: GroundingService) {}
  @Get("runs/:runId/grounding") diagnostics(@Param("runId") runId:string,@CurrentPrincipal() principal:Principal){return this.service.diagnostics(principal,runId);}
  @Get("runs/:runId/protected-transactions/:operationId/recovery") recoveryState(@Param("runId") runId:string,@Param("operationId") operationId:string,@CurrentPrincipal() principal:Principal){return this.service.recoveryState(principal,runId,operationId);}
  @Post("runs/:runId/protected-transactions/:operationId/recovery") recovery(@Param("runId") runId:string,@Param("operationId") operationId:string,@CurrentPrincipal() principal:Principal,@Body(new ZodValidationPipe(protectedRecoveryCommandSchema)) input:ProtectedRecoveryCommand){return this.service.protectedRecovery(principal,runId,operationId,input);}
}
