import {
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Inject,
  Body,
  ForbiddenException,
  Header,
} from "@nestjs/common";
import { z } from "zod";
import { TestingOperations } from "../../auth/auth.guard.js";
import { CurrentPrincipal } from "../../auth/current-principal.decorator.js";
import type { Principal } from "../../auth/auth.types.js";
import { ZodValidationPipe } from "../../common/validation.pipe.js";
import { BrowserCommandRepository } from "../repositories/browser-command.repository.js";
@Controller("api/runs/:runId/generated-secrets")
@TestingOperations()
export class BrowserGeneratedSecretsController {
  constructor(
    @Inject(BrowserCommandRepository) private readonly commands: BrowserCommandRepository,
  ) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  async list(@CurrentPrincipal() p: Principal, @Param("runId", new ParseUUIDPipe()) id: string) {
    return {
      items: await this.commands.listGeneratedSecrets(
        p.kind === "user" ? p.workspaceId : undefined,
        id,
      ),
    };
  }
  @Post(":valueId/revoke")
  @Header("Cache-Control", "private, no-store")
  async revoke(
    @CurrentPrincipal() p: Principal,
    @Param("runId", new ParseUUIDPipe()) run: string,
    @Param("valueId", new ParseUUIDPipe()) value: string,
    @Body(new ZodValidationPipe(z.strictObject({ userConfirmed: z.literal(true) })))
    _input: { userConfirmed: true },
  ) {
    if (p.kind === "user" && p.role === "viewer")
      throw new ForbiddenException("TEST_RESOURCE_WRITE_FORBIDDEN");
    return {
      reference: await this.commands.revokeGeneratedSecret(
        p.kind === "user" ? p.workspaceId : undefined,
        run,
        value,
      ),
      applicationRevocation: "not_performed",
    };
  }
}
