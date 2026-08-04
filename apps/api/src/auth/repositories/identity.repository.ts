import { Inject, Injectable } from "@nestjs/common";

import { Database } from "../../infrastructure/database.js";
import type { UserPrincipal } from "../auth.types.js";

@Injectable()
export class IdentityRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async provisionUser(subject: string, email: string): Promise<UserPrincipal> {
    return this.database.transaction(async (client) => {
      const user = (
        await client.query(
          `INSERT INTO app_users(supabase_user_id, email)
           VALUES ($1::uuid, $2)
           ON CONFLICT (supabase_user_id) DO UPDATE
             SET email = EXCLUDED.email, updated_at = now()
           RETURNING id, supabase_user_id`,
          [subject, email],
        )
      ).rows[0]!;

      const existing = await client.query(
        `SELECT w.id AS workspace_id, wm.role
         FROM workspace_memberships wm
         JOIN workspaces w ON w.id = wm.workspace_id
         WHERE wm.user_id = $1
         ORDER BY wm.created_at
         LIMIT 1`,
        [user.id],
      );

      let workspaceId: string;
      let role: UserPrincipal["role"];
      if (existing.rowCount) {
        workspaceId = existing.rows[0]!.workspace_id;
        role = existing.rows[0]!.role;
      } else {
        const workspace = (
          await client.query(
            `INSERT INTO workspaces(name, slug)
             VALUES ($1, $2)
             RETURNING id`,
            [workspaceName(email), `personal-${subject}`],
          )
        ).rows[0]!;
        await client.query(
          `INSERT INTO workspace_memberships(workspace_id, user_id, role)
           VALUES ($1, $2, 'owner')`,
          [workspace.id, user.id],
        );
        workspaceId = workspace.id;
        role = "owner";
      }

      return {
        kind: "user",
        subject,
        userId: user.id,
        email,
        workspaceId,
        role,
      };
    });
  }

  async principalForMcpToken(tokenHash: string): Promise<UserPrincipal | undefined> {
    const result = await this.database.query(
      `UPDATE mcp_access_tokens token
       SET last_used_at = now()
       FROM app_users user_account, workspace_memberships membership
       WHERE token.token_hash = $1
         AND token.revoked_at IS NULL
         AND (token.expires_at IS NULL OR token.expires_at > now())
         AND user_account.id = token.user_id
         AND membership.user_id = token.user_id
         AND membership.workspace_id = token.workspace_id
       RETURNING user_account.supabase_user_id, user_account.id AS user_id,
         user_account.email, token.workspace_id, membership.role`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      kind: "user",
      subject: row.supabase_user_id,
      userId: row.user_id,
      email: row.email,
      workspaceId: row.workspace_id,
      role: row.role,
    };
  }
}

function workspaceName(email: string) {
  const localPart = email.split("@")[0]?.trim();
  return localPart ? `${localPart}'s workspace` : "My workspace";
}
