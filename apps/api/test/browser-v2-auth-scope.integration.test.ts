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
    if (authenticated.kind !== "user") throw new Error("Expected an authenticated user");
    expect(authenticated).toMatchObject({
      kind: "user",
      credentialKind: "mcp",
      userId: userA,
      workspaceId: workspaceA,
      role: "owner",
    });

    const lifecycle = new BrowserLifecycleRepository(database);
    const commands = new BrowserCommandRepository(database, new BrowserProtectedValueCipher());
    const controller = new BrowserLifecycleController(
      lifecycle,
      undefined as never,
      commands,
      undefined as never,
    );
    const mcpEnvironment = await controller.createEnvironment(projectA, authenticated, {
      name: "mcp-assigned",
      baseOrigin: "https://mcp-assigned.example",
      allowedServiceOrigins: [],
      disclosureMode: "trusted_application_output",
      idempotencyKey: `mcp-environment-${projectA}`,
    });
    expect(mcpEnvironment).toMatchObject({
      replay: false,
      environmentId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    await expect(controller.listEnvironments(projectA, authenticated)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: environmentA,
          projectId: projectA,
          name: "environment A",
          baseOrigin: "https://fixture.example",
          allowedServiceOrigins: [],
          disclosureMode: "confidential",
          state: "active",
        }),
        expect.objectContaining({
          id: mcpEnvironment.environmentId,
          projectId: projectA,
          name: "mcp-assigned",
          baseOrigin: "https://mcp-assigned.example",
          state: "active",
        }),
      ]),
    );
    await expect(
      controller.createEnvironment(projectB, authenticated, {
        name: "cross-workspace",
        baseOrigin: "https://cross-workspace.example",
        allowedServiceOrigins: [],
        disclosureMode: "confidential",
        idempotencyKey: `cross-workspace-${projectB}`,
      }),
    ).rejects.toThrow("BROWSER_V2_PROJECT_NOT_FOUND");
    await expect(controller.listEnvironments(projectB, authenticated)).rejects.toThrow(
      "BROWSER_V2_PROJECT_NOT_FOUND",
    );
    const credential = await controller.createProtectedInput(projectA, authenticated, {
      displayName: "Preview_password",
      value: "scope-protected-canary",
      expiresInSeconds: null,
      idempotencyKey: `credential-${projectA}`,
    });
    await expect(controller.listProtectedInputs(projectA, authenticated)).resolves.toEqual([
      expect.objectContaining({
        id: credential.protectedValueId,
        referenceId: credential.protectedValueId,
        projectId: projectA,
        displayName: "Preview_password",
        state: "active",
        expiresAt: null,
      }),
    ]);
    await expect(controller.listProtectedInputs(projectB, authenticated)).rejects.toThrow(
      "BROWSER_V2_PROJECT_NOT_FOUND",
    );
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
    const objective = await lifecycle.createObjective(workspaceA, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      title: "Authenticate safely",
      description: "Use only the credential selected for this Project",
      completionCriteria: { authenticated: true },
      objectiveOrder: 0,
      idempotencyKey: `scoped-objective-${projectA}`,
    });
    const flow = await lifecycle.createFlow(workspaceA, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      name: "Discover login",
      purpose: "Reach and authenticate through the approved login surface",
      definition: {},
      idempotencyKey: `scoped-flow-${projectA}`,
    });
    const run = await lifecycle.startRun(workspaceA, {
      projectId: projectA,
      missionId: mission.missionId,
      objectiveId: objective.objectiveId,
      agentSessionId: mission.agentSessionId,
      flowId: flow.flowId,
      flowRevisionId: flow.flowRevisionId,
      environmentId: environmentA,
      authenticationCommitLimit: 1,
      businessCommitLimit: 0,
      protectedInputIds: [],
      idempotencyKey: `scoped-run-${projectA}`,
    });
    await controller.createEnvironment(projectA, authenticated, {
      name: "later mission scope",
      baseOrigin: "https://later-scope.example",
      allowedServiceOrigins: ["https://later-api.example"],
      disclosureMode: "trusted_application_output",
      idempotencyKey: `later-environment-${projectA}`,
    });
    const runScope = await database.query<{
      allowedFirstPartyOrigins: string[];
      allowedServiceOrigins: string[];
      disclosureMode: string;
    }>(
      `SELECT allowed_first_party_origins AS "allowedFirstPartyOrigins",
              allowed_service_origins AS "allowedServiceOrigins",
              disclosure_mode AS "disclosureMode"
       FROM browser_execution_sessions WHERE id=$1`,
      [run.browserSessionId],
    );
    expect(runScope.rows[0]).toEqual({
      allowedFirstPartyOrigins: ["https://fixture.example"],
      allowedServiceOrigins: [],
      disclosureMode: "confidential",
    });
    await expect(
      controller.bindProtectedInputs(run.runId, authenticated, {
        protectedInputIds: [credential.protectedValueId],
        userConfirmed: true,
      }),
    ).resolves.toMatchObject({
      browserSessionId: run.browserSessionId,
      protectedInputIds: [credential.protectedValueId],
      added: 1,
    });
    await expect(
      controller.bindProtectedInputs(
        run.runId,
        { ...authenticated, workspaceId: workspaceB },
        {
          protectedInputIds: [credential.protectedValueId],
          userConfirmed: true,
        },
      ),
    ).rejects.toThrow("BROWSER_V2_RUN_NOT_ACTIVE");
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
