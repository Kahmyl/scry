import { Controller, Delete, Get, Inject, Param, Post, Body } from "@nestjs/common";

import { CurrentPrincipal } from "./current-principal.decorator.js";
import { McpTokenRepository } from "./repositories/mcp-token.repository.js";
import type { Principal } from "./auth.types.js";

@Controller("api/mcp-tokens")
export class McpTokensController {
  constructor(@Inject(McpTokenRepository) private readonly tokens: McpTokenRepository) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal) {
    return this.tokens.list(principal);
  }

  @Post()
  create(@CurrentPrincipal() principal: Principal, @Body() input: { name?: string }) {
    return this.tokens.create(principal, input.name?.trim() || "MCP connection");
  }

  @Delete(":tokenId")
  revoke(@Param("tokenId") tokenId: string, @CurrentPrincipal() principal: Principal) {
    return this.tokens.revoke(principal, tokenId);
  }
}
