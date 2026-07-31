import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";

import { Database } from "./database.js";
import type { Principal, UserPrincipal } from "./auth.types.js";

@Injectable()
export class McpTokenRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async list(principal: Principal) {
    const user = requireUser(principal);
    const result = await this.database.query(
      `SELECT id, name, token_prefix, last_used_at, expires_at, revoked_at, created_at
       FROM mcp_access_tokens
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [user.workspaceId],
    );
    return result.rows.map(serialize);
  }

  async create(principal: Principal, name: string) {
    const user = requireUser(principal);
    const token = `scry_mcp_${randomBytes(32).toString("base64url")}`;
    const prefix = `${token.slice(0, 17)}…`;
    const result = await this.database.query(
      `INSERT INTO mcp_access_tokens(workspace_id, user_id, name, token_prefix, token_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, token_prefix, last_used_at, expires_at, revoked_at, created_at`,
      [
        user.workspaceId,
        user.userId,
        name.trim(),
        prefix,
        createHash("sha256").update(token).digest("hex"),
      ],
    );
    return { ...serialize(result.rows[0]!), token };
  }

  async revoke(principal: Principal, tokenId: string) {
    const user = requireUser(principal);
    const result = await this.database.query(
      `UPDATE mcp_access_tokens
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1 AND workspace_id = $2
       RETURNING id, name, token_prefix, last_used_at, expires_at, revoked_at, created_at`,
      [tokenId, user.workspaceId],
    );
    if (!result.rows[0]) throw new ForbiddenException("MCP access token not found");
    return serialize(result.rows[0]);
  }
}

function requireUser(principal: Principal): UserPrincipal {
  if (principal.kind !== "user") {
    throw new ForbiddenException("MCP access tokens require a signed-in user");
  }
  return principal;
}

function serialize(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}
