import { Body, Controller, Get, Inject, Param, Patch } from "@nestjs/common";
import { veilPreferenceUpdateSchema, type VeilPreferenceUpdate } from "@scry/contracts";

import { CurrentPrincipal, type Principal } from "../auth/index.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";
import { VeilPreferencesService } from "./preferences.service.js";

@Controller("api/environments")
export class VeilPreferencesController {
  constructor(
    @Inject(VeilPreferencesService) private readonly preferences: VeilPreferencesService,
  ) {}

  @Get(":environmentId/veil")
  get(@Param("environmentId") environmentId: string, @CurrentPrincipal() principal: Principal) {
    return this.preferences.get(principal, environmentId);
  }

  @Patch(":environmentId/veil")
  tighten(
    @Param("environmentId") environmentId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(veilPreferenceUpdateSchema)) input: VeilPreferenceUpdate,
  ) {
    return this.preferences.tighten(principal, environmentId, input);
  }
}
