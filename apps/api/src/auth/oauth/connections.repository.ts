import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { Principal, UserPrincipal } from "../auth.types.js";
import { Database } from "../../infrastructure/database.js";
import { digest } from "./provider-adapter.js";
import { testingScope } from "./config.js";

export function requireDashboardUser(principal: Principal): UserPrincipal {
  if (
    principal.kind !== "user" ||
    (principal.credentialKind && principal.credentialKind !== "user")
  )
    throw new ForbiddenException("Sign in to Scry to manage connections.");
  return principal;
}

@Injectable()
export class ConnectionsRepository {
  constructor(@Inject(Database) private readonly database: Database) {}
  async workspaces(principal: Principal) {
    const user = requireDashboardUser(principal);
    return (
      await this.database.query(
        `SELECT w.id,w.name,m.role FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.name,w.id`,
        [user.userId],
      )
    ).rows;
  }
  async approve(
    principal: Principal,
    input: { workspaceId: string; clientId: string; clientName: string; grantId: string },
  ) {
    const user = requireDashboardUser(principal);
    const result = await this.database.query(
      `INSERT INTO oauth_connections(user_id,workspace_id,client_id,client_name,grant_hash,scope)
      SELECT $1,m.workspace_id,$3,$4,$5,$6 FROM workspace_memberships m WHERE m.user_id=$1 AND m.workspace_id=$2
      RETURNING id`,
      [
        user.userId,
        input.workspaceId,
        input.clientId,
        input.clientName.slice(0, 100),
        digest(input.grantId),
        testingScope,
      ],
    );
    if (!result.rowCount) throw new ForbiddenException("Choose a workspace you belong to.");
    return result.rows[0]!.id as string;
  }
  async principal(grantId: string, accountId: string, clientId: string) {
    const result = await this.database.query(
      `UPDATE oauth_connections c SET last_used_at=now()
      FROM app_users u,workspace_memberships m
      WHERE c.grant_hash=$1 AND c.user_id=$2 AND c.client_id=$3 AND c.revoked_at IS NULL
        AND u.id=c.user_id AND m.user_id=c.user_id AND m.workspace_id=c.workspace_id
      RETURNING c.id,u.id AS user_id,u.supabase_user_id,u.email,c.workspace_id,m.role`,
      [digest(grantId), accountId, clientId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      kind: "user",
      credentialKind: "mcp",
      subject: row.supabase_user_id,
      userId: row.user_id,
      email: row.email,
      workspaceId: row.workspace_id,
      role: row.role,
      oauthConnectionId: row.id,
    } as UserPrincipal;
  }
  async list(principal: Principal) {
    const user = requireDashboardUser(principal);
    return (
      await this.database.query(
        `SELECT c.id,c.client_name AS "clientName",w.name AS "workspaceName",c.created_at AS "createdAt",c.last_used_at AS "lastUsedAt",c.revoked_at AS "revokedAt",
          (g.id_hash IS NULL OR g.expires_at<=now()) AS expired
      FROM oauth_connections c JOIN workspaces w ON w.id=c.workspace_id
      LEFT JOIN oauth_provider_records g ON g.model='Grant' AND g.id_hash=c.grant_hash
      WHERE c.user_id=$1 ORDER BY c.created_at DESC`,
        [user.userId],
      )
    ).rows;
  }
  async revoke(principal: Principal, id: string) {
    const user = requireDashboardUser(principal);
    await this.database.transaction(async (client) => {
      const result = await client.query(
        "UPDATE oauth_connections SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2 RETURNING grant_hash",
        [id, user.userId],
      );
      if (!result.rowCount) throw new ForbiddenException("Connection not found.");
      await client.query("DELETE FROM oauth_provider_records WHERE grant_hash=$1", [
        result.rows[0]!.grant_hash,
      ]);
    });
    return { disconnected: true };
  }
}
