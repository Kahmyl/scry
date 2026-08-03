import { Body, Controller, Inject, Param, Patch, Post } from "@nestjs/common";
import {
  updateEnvironmentSchema,
  validateCredentialReferencesSchema,
  type UpdateEnvironmentInput,
  type ValidateCredentialReferencesInput,
} from "@scry/contracts";

import { CurrentPrincipal, type Principal } from "../../auth/index.js";
import { ZodValidationPipe } from "../../common/validation.pipe.js";
import { ScryRepository } from "../repositories/scry.repository.js";

@Controller("api/environments")
export class EnvironmentsController {
  constructor(@Inject(ScryRepository) private readonly repository: ScryRepository) {}

  @Patch(":environmentId")
  update(
    @Param("environmentId") environmentId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(updateEnvironmentSchema)) input: UpdateEnvironmentInput,
  ) {
    return this.repository.updateEnvironment(principal, environmentId, input);
  }

  @Post(":environmentId/validate-credentials")
  validateCredentials(
    @Param("environmentId") environmentId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(validateCredentialReferencesSchema))
    input: ValidateCredentialReferencesInput,
  ) {
    return this.repository.validateCredentialReferences(principal, environmentId, input);
  }
}
