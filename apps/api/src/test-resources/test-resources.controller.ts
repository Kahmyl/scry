import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import {
  createTestResourceSchema,
  connectTestMailboxSchema,
  type ConnectTestMailboxInput,
  refreshTestResourceSchema,
  useTestSecretSchema,
  type CreateTestResourceInput,
  type RefreshTestResourceInput,
} from "@scry/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { Principal } from "../auth/auth.types.js";
import { ZodValidationPipe } from "../common/validation.pipe.js";
import { TestResourcesService } from "./test-resources.service.js";
import { withProviderBudget } from "./provider-http.js";

@Controller("api")
export class TestResourcesController {
  constructor(@Inject(TestResourcesService) readonly service: TestResourcesService) {}
  @Get("missions/:missionId/test-resources")
  @Header("Cache-Control", "private, no-store")
  list(@CurrentPrincipal() p: Principal, @Param("missionId", new ParseUUIDPipe()) id: string) {
    return this.service.list(scope(p), id);
  }
  @Post("missions/:missionId/test-resources")
  @Header("Cache-Control", "private, no-store")
  create(
    @CurrentPrincipal() p: Principal,
    @Param("missionId", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(createTestResourceSchema)) input: CreateTestResourceInput,
  ) {
    write(p);
    return withProviderBudget(() => this.service.create(scope(p), id, input));
  }
  @Post("missions/:missionId/test-resources/connect-mailbox")
  @Header("Cache-Control", "private, no-store")
  connect(
    @CurrentPrincipal() p: Principal,
    @Param("missionId", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(connectTestMailboxSchema)) input: ConnectTestMailboxInput,
  ) {
    write(p);
    return withProviderBudget(() => this.service.connect(scope(p), id, input));
  }
  @Get("test-resources/:id/events")
  @Header("Cache-Control", "private, no-store")
  events(@CurrentPrincipal() p: Principal, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.service.repository.events(scope(p), id);
  }
  @Post("test-resources/:id/refresh")
  @Header("Cache-Control", "private, no-store")
  refresh(
    @CurrentPrincipal() p: Principal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(refreshTestResourceSchema)) input: RefreshTestResourceInput,
  ) {
    write(p);
    return withProviderBudget(() => this.service.read(scope(p), id, input));
  }
  @Post("test-resources/:id/close")
  @Header("Cache-Control", "private, no-store")
  close(@CurrentPrincipal() p: Principal, @Param("id", new ParseUUIDPipe()) id: string) {
    write(p);
    return withProviderBudget(() => this.service.close(scope(p), id));
  }
  @Post("test-resources/:id/use-secret")
  @Header("Cache-Control", "private, no-store")
  use(
    @CurrentPrincipal() p: Principal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(useTestSecretSchema))
    input: { runId: string; protectedValueId: string },
  ) {
    write(p);
    return this.service.useSecret(scope(p), id, input.runId, input.protectedValueId);
  }
}
function scope(p: Principal) {
  return p.kind === "user" ? p.workspaceId : undefined;
}
function write(p: Principal) {
  if (p.kind === "user" && p.role === "viewer")
    throw new ForbiddenException("TEST_RESOURCE_WRITE_FORBIDDEN");
}
