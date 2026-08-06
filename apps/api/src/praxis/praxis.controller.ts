import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { interactionTargetIntentSchema } from "@scry/contracts";
import { z } from "zod";

import { ZodValidationPipe } from "../common/validation.pipe.js";
import { PraxisService } from "./praxis.service.js";

const praxisRequestIdSchema = z.string().uuid();

const createPraxisInspectionSchema = z
  .object({
    intent: interactionTargetIntentSchema,
    allowedOrigins: z.array(z.string().url()).min(1).max(100),
    probeSessionId: z.string().uuid(),
  })
  .strict();

type CreatePraxisInspectionInput = z.infer<
  typeof createPraxisInspectionSchema
>;

@Controller("api/praxis")
export class PraxisController {
  constructor(private readonly praxis: PraxisService) {}

  @Get("candidate-inspections/:requestId")
  getInspection(
    @Param("requestId", new ZodValidationPipe(praxisRequestIdSchema))
    requestId: string,
  ) {
    return this.praxis.getInspection(requestId);
  }

  @Post("candidate-inspections")
  createInspection(
    @Body(new ZodValidationPipe(createPraxisInspectionSchema))
    input: CreatePraxisInspectionInput,
  ) {
    return this.praxis.createInspection(input);
  }
}
