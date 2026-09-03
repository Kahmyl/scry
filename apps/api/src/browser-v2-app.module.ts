import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";

import { AuthGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import { McpTokensController } from "./auth/mcp-tokens.controller.js";
import { IdentityRepository } from "./auth/repositories/identity.repository.js";
import { McpTokenRepository } from "./auth/repositories/mcp-token.repository.js";
import { BrowserExecutionModule } from "./browser-execution/index.js";
import { BrowserV2ExceptionFilter } from "./browser-execution/browser-v2-exception.filter.js";

@Module({
  imports: [BrowserExecutionModule],
  controllers: [McpTokensController],
  providers: [
    IdentityRepository,
    McpTokenRepository,
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: BrowserV2ExceptionFilter },
  ],
})
export class BrowserV2AppModule {}
