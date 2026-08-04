import { Body, Controller, Delete, Inject, Param, Patch } from "@nestjs/common";
import { updateCredentialSchema, type UpdateCredentialInput } from "@scry/contracts";

import { CurrentPrincipal, type Principal } from "../../auth/index.js";
import { ZodValidationPipe } from "../../common/validation.pipe.js";
import { ScryRepository } from "../repositories/scry.repository.js";

@Controller("api/credentials")
export class CredentialsController {
  constructor(@Inject(ScryRepository) private readonly repository: ScryRepository) {}

  @Patch(":credentialId")
  update(
    @Param("credentialId") credentialId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(updateCredentialSchema)) input: UpdateCredentialInput,
  ) {
    return this.repository.updateCredential(principal, credentialId, input);
  }

  @Delete(":credentialId")
  remove(@Param("credentialId") credentialId: string, @CurrentPrincipal() principal: Principal) {
    return this.repository.deleteCredential(principal, credentialId);
  }
}
