import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";

import type { Principal } from "../../auth/auth.types.js";
import { Database } from "../../infrastructure/database.js";

@Injectable()
export class BrowserProjectRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async list(principal: Principal) {
    const result = await this.database.query(
      `SELECT id,name,description,created_at AS "createdAt",updated_at AS "updatedAt"
       FROM projects
       WHERE ($1::uuid IS NULL OR workspace_id=$1)
       ORDER BY updated_at DESC,created_at DESC`,
      [principal.kind === "user" ? principal.workspaceId : null],
    );
    return result.rows;
  }

  async create(principal: Principal, input: { name: string; description: string }) {
    if (principal.kind !== "user" || principal.credentialKind === "mcp")
      throw new ForbiddenException("BROWSER_V2_PROJECT_USER_BOUNDARY_REQUIRED");
    if (!["owner", "admin"].includes(principal.role))
      throw new ForbiddenException("BROWSER_V2_PROJECT_POLICY_FORBIDDEN");
    try {
      const result = await this.database.query(
        `INSERT INTO projects(id,workspace_id,name,description)
         VALUES($1,$2,$3,$4)
         RETURNING id,name,description,created_at AS "createdAt",updated_at AS "updatedAt"`,
        [randomUUID(), principal.workspaceId, input.name, input.description],
      );
      return result.rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException("BROWSER_V2_PROJECT_NAME_CONFLICT");
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
