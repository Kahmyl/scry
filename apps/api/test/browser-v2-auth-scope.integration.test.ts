import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthService } from "../src/auth/auth.service.js";
import { IdentityRepository } from "../src/auth/repositories/identity.repository.js";
import { McpTokenRepository } from "../src/auth/repositories/mcp-token.repository.js";
import type { UserPrincipal } from "../src/auth/auth.types.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserLifecycleController } from "../src/browser-execution/controllers/browser-lifecycle.controller.js";
import { BrowserLifecycleRepository } from "../src/browser-execution/repositories/browser-lifecycle.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";

const databaseUrl = process.env.BROWSER_V2_TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("browser v2 customer MCP scope", () => {
  let database: Database;

  beforeAll(() => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.BROWSER_V2_ENABLED = "true";
    process.env.BROWSER_V2_PROTECTED_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
    database = new Database();
  });

  afterAll(async () => {
    if (database) await database.onModuleDestroy();
  });

  it("authenticates a customer token and denies every cross-workspace project and Mission access", async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const projectA = randomUUID();
    const projectB = randomUUID();
    const environmentA = randomUUID();
    await database.transaction(async (client) => {
      await client.query(
        "INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$2,$3),($4,$5,$6)",
        [
          userA,
          randomUUID(),
          `${userA}@example.test`,
          userB,
          randomUUID(),
          `${userB}@example.test`,
        ],
      );
      await client.query(
        "INSERT INTO workspaces(id,name,slug) VALUES($1,'scope A',$2),($3,'scope B',$4)",
        [workspaceA, `scope-a-${workspaceA}`, workspaceB, `scope-b-${workspaceB}`],
      );
      await client.query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')",
        [workspaceA, userA, workspaceB, userB],
      );
      await client.query(
        "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'project A'),($3,$4,'project B')",
        [projectA, workspaceA, projectB, workspaceB],
      );
      await client.query(
        "INSERT INTO environments(id,project_id,name,base_origin) VALUES($1,$2,'environment A','https://fixture.example')",
        [environmentA, projectA],
      );
    });

    const principalA: UserPrincipal = {
      kind: "user",
      subject: randomUUID(),
      userId: userA,
      email: `${userA}@example.test`,
      workspaceId: workspaceA,
      role: "owner",
    };
    const tokens = new McpTokenRepository(database);
    const issued = await tokens.create(principalA, "qualification");
    const authenticated = await new AuthService(new IdentityRepository(database)).authenticate(
      `Bearer ${issued.token}`,
    );
    expect(authenticated).toMatchObject({
      kind: "user",
      credentialKind: "mcp",
      userId: userA,
      workspaceId: workspaceA,
      role: "owner",
    });

    const lifecycle = new BrowserLifecycleRepository(database);
    const controller = new BrowserLifecycleController(
      lifecycle,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect(() =>
      controller.createEnvironment(projectA, authenticated, {
        name: "mcp-forbidden",
        baseOrigin: "https://mcp-forbidden.example",
        allowedServiceOrigins: [],
        disclosureMode: "trusted_application_output",
        idempotencyKey: `mcp-environment-${projectA}`,
      }),
    ).toThrow("BROWSER_V2_ENVIRONMENT_POLICY_FORBIDDEN");
    expect(() =>
      controller.createEnvironment(
        projectA,
        { ...principalA, credentialKind: "user", role: "viewer" },
        {
          name: "viewer-forbidden",
          baseOrigin: "https://viewer-forbidden.example",
          allowedServiceOrigins: [],
          disclosureMode: "trusted_application_output",
          idempotencyKey: `viewer-environment-${projectA}`,
        },
      ),
    ).toThrow("BROWSER_V2_ENVIRONMENT_POLICY_FORBIDDEN");
    await expect(
      controller.createEnvironment(
        projectA,
        { ...principalA, credentialKind: "user" },
        {
          name: "owner-environment",
          baseOrigin: "https://owner-environment.example",
          allowedServiceOrigins: [],
          disclosureMode: "trusted_application_output",
          idempotencyKey: `owner-environment-${projectA}`,
        },
      ),
    ).resolves.toMatchObject({
      replay: false,
      environmentId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    const mission = await lifecycle.startMission(workspaceA, {
      projectId: projectA,
      title: "Scoped mission",
      instruction: "Remain inside this workspace",
      provider: "codex",
      settings: {},
      idempotencyKey: `scoped-mission-${projectA}`,
    });
    await expect(
      lifecycle.startMission(workspaceA, {
        projectId: projectB,
        title: "Forbidden mission",
        instruction: "Must be denied",
        provider: "codex",
        settings: {},
        idempotencyKey: `cross-scope-${projectB}`,
      }),
    ).rejects.toThrow("BROWSER_V2_PROJECT_NOT_FOUND");
    await expect(lifecycle.observeMission(workspaceB, mission.missionId)).rejects.toThrow(
      "BROWSER_V2_MISSION_NOT_FOUND",
    );
    expect(await lifecycle.listMissions(workspaceA, projectB)).toEqual([]);

    const commands = new BrowserCommandRepository(database, new BrowserProtectedValueCipher());
    await expect(
      commands.createProtectedInput(workspaceA, {
        projectId: projectB,
        displayName: "forbidden",
        value: "must-not-cross-scope",
        expiresInSeconds: 600,
        idempotencyKey: `cross-scope-protected-${projectB}`,
      }),
    ).rejects.toThrow("BROWSER_V2_PROJECT_NOT_FOUND");

    await tokens.revoke(principalA, String(issued.id));
    await expect(
      new AuthService(new IdentityRepository(database)).authenticate(`Bearer ${issued.token}`),
    ).rejects.toThrow("The MCP access token is invalid, expired, or revoked");
  });
});
