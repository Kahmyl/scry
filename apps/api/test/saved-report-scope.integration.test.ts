import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth.service.js";
import { IdentityRepository } from "../src/auth/repositories/identity.repository.js";
import { McpTokenRepository } from "../src/auth/repositories/mcp-token.repository.js";
import type { UserPrincipal } from "../src/auth/auth.types.js";
import { BrowserDashboardController } from "../src/browser-execution/controllers/browser-dashboard.controller.js";
import { BrowserDashboardRepository } from "../src/browser-execution/repositories/browser-dashboard.repository.js";
import { BrowserLifecycleRepository } from "../src/browser-execution/repositories/browser-lifecycle.repository.js";
import { BrowserRuntimeVeilReportProtection } from "../src/browser-execution/browser-boundary-composition.js";
import { Database } from "../src/infrastructure/database.js";

const run = process.env.SCRY_BROWSER_TEST_DATABASE_URL ? describe : describe.skip;
run("saved customer report workspace boundary", () => {
  let database: Database;
  let controller: BrowserDashboardController;
  let principal: UserPrincipal;
  const userId = randomUUID(),
    workspaceId = randomUUID(),
    otherWorkspaceId = randomUUID(),
    projectId = randomUUID(),
    reportId = randomUUID();
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
    database = new Database();
    await database.transaction(async (db) => {
      await db.query("INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$2,$3)", [
        userId,
        randomUUID(),
        `${userId}@example.test`,
      ]);
      await db.query(
        "INSERT INTO workspaces(id,name,slug) VALUES($1,'report A',$2),($3,'report B',$4)",
        [workspaceId, `report-a-${workspaceId}`, otherWorkspaceId, `report-b-${otherWorkspaceId}`],
      );
      await db.query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [workspaceId, userId],
      );
      await db.query(
        "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Report review fixture')",
        [projectId, workspaceId],
      );
    });
    principal = {
      kind: "user",
      subject: userId,
      userId,
      email: `${userId}@example.test`,
      workspaceId,
      role: "owner",
    };
    const issued = await new McpTokenRepository(database).create(principal, "saved report fixture");
    const authenticated = await new AuthService(new IdentityRepository(database)).authenticate(
      `Bearer ${issued.token}`,
    );
    if (authenticated.kind !== "user") throw new Error("Expected scoped MCP principal");
    principal = authenticated;
    const lifecycle = new BrowserLifecycleRepository(
      database,
      new BrowserRuntimeVeilReportProtection(),
    );
    const mission = await lifecycle.startMission(workspaceId, {
      projectId,
      title: "Saved support check",
      instruction: "Read only; no email delivery",
      provider: "codex",
      settings: {},
      idempotencyKey: `saved-report-${projectId}`,
    });
    await database.query(
      "INSERT INTO mission_reports(id,mission_id,state,summary,safe_report,evidence_digest) VALUES($1,$2,'draft','Support heading found',$3,$4)",
      [
        reportId,
        mission.missionId,
        JSON.stringify({
          presentation: {
            subject: "application",
            scope: ["Support"],
            checks: [
              {
                title: "Support heading",
                expected: "Heading visible",
                actual: "Heading visible",
                status: "matched_expectation",
                evidence: [],
              },
            ],
            observations: [],
            limitations: ["Email delivery was excluded"],
          },
          operatorLog: "PRIVATE_OPERATOR_CANARY",
        }),
        "a".repeat(64),
      ],
    );
    controller = new BrowserDashboardController(
      new BrowserDashboardRepository(database),
      lifecycle,
    );
  });
  afterAll(async () => {
    if (database) {
      try {
        await database.query("DELETE FROM projects WHERE id=$1", [projectId]);
        await database.query("DELETE FROM workspaces WHERE id=ANY($1::uuid[])", [
          [workspaceId, otherWorkspaceId],
        ]);
        await database.query("DELETE FROM app_users WHERE id=$1", [userId]);
      } finally {
        await database.onModuleDestroy();
      }
    }
  });
  it("reads saved checks and limitations through an authenticated MCP principal without chat state", async () => {
    expect(principal.credentialKind).toBe("mcp");
    const report = await controller.getReport(reportId, principal);
    expect(report).toMatchObject({
      id: reportId,
      projectId,
      safeReport: {
        presentation: {
          checks: [{ status: "matched_expectation" }],
          limitations: ["Email delivery was excluded"],
        },
      },
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_OPERATOR_CANARY");
    expect(JSON.stringify(report)).not.toContain("evidenceDigest");
    expect(await controller.listReports(projectId, principal)).toEqual([
      expect.objectContaining({ id: reportId }),
    ]);
  });
  it("refuses report IDs from another workspace and missing reports without privileged fallback", async () => {
    await expect(
      controller.getReport(reportId, { ...principal, workspaceId: otherWorkspaceId }),
    ).rejects.toThrow("SCRY_BROWSER_REPORT_NOT_FOUND");
    await expect(controller.getReport(randomUUID(), principal)).rejects.toThrow(
      "SCRY_BROWSER_REPORT_NOT_FOUND",
    );
    expect(
      await controller.listReports(projectId, { ...principal, workspaceId: otherWorkspaceId }),
    ).toEqual([]);
  });
});
