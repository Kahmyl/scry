import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { InfrastructureModule } from "../infrastructure/index.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { IdentityRepository } from "./repositories/identity.repository.js";
import { McpTokenRepository } from "./repositories/mcp-token.repository.js";
import { McpTokensController } from "./mcp-tokens.controller.js";

@Module({
  imports: [InfrastructureModule],
  controllers: [McpTokensController],
  providers: [
    IdentityRepository,
    McpTokenRepository,
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
