import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";

import { AuthGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import { McpTokensController } from "./auth/mcp-tokens.controller.js";
import { IdentityRepository } from "./auth/repositories/identity.repository.js";
import { McpTokenRepository } from "./auth/repositories/mcp-token.repository.js";
import { BrowserExecutionModule } from "./browser-execution/index.js";
import { BrowserExceptionFilter } from "./browser-execution/browser-exception.filter.js";
import { TestResourcesModule } from "./test-resources/test-resources.module.js";
import { OAuthService } from "./auth/oauth/oauth.service.js";
import { ConnectionsRepository } from "./auth/oauth/connections.repository.js";
import { ConnectionsController } from "./auth/oauth/connections.controller.js";

@Module({
  imports: [BrowserExecutionModule, TestResourcesModule],
  controllers: [McpTokensController, ConnectionsController],
  providers: [
    IdentityRepository,
    McpTokenRepository,
    AuthService,
    OAuthService,
    ConnectionsRepository,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: BrowserExceptionFilter },
  ],
})
export class AppModule {}
