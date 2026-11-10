import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { BrowserLifecycleRepository } from "../src/browser-execution/repositories/browser-lifecycle.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserRuntimeVeilReportProtection } from "../src/browser-execution/browser-boundary-composition.js";
import { seedSession } from "./fixtures/browser-session.js";
const target = process.env.SCRY_DEPLOYMENT_TEST_DATABASE_URL;
(target ? describe : describe.skip)(
  "race-safe deployment gate against actual session/command writers",
  () => {
    let db: Database,
      execution: BrowserExecutionRepository,
      lifecycle: BrowserLifecycleRepository,
      commands: BrowserCommandRepository;
    beforeAll(() => {
      vi.stubEnv("DATABASE_URL", target!);
      vi.stubEnv("SCRY_BROWSER_MAX_LIVE_SESSIONS", "1000");
      vi.stubEnv("SCRY_BROWSER_PROTECTED_KEY_BASE64", randomBytes(32).toString("base64"));
      db = new Database();
      const cipher = new BrowserProtectedValueCipher();
      execution = new BrowserExecutionRepository(db, cipher);
      lifecycle = new BrowserLifecycleRepository(db, new BrowserRuntimeVeilReportProtection());
      commands = new BrowserCommandRepository(db, cipher);
    });
    afterAll(async () => {
      await db?.query("UPDATE browser_deployment_admission SET held=false,owner=NULL");
      await db?.onModuleDestroy();
      vi.unstubAllEnvs();
    });
    const gate = async (owner: string) =>
      (await db.query<{ n: number | null }>("SELECT browser_try_deployment($1) AS n", [owner]))
        .rows[0]!.n;
    it("holds admission without active work; another controller cannot steal or release it", async () => {
      const owner = randomUUID();
      expect(await gate(owner)).toBe(0);
      expect(await gate("different")).toBeNull();
      await db.query(
        "UPDATE browser_deployment_admission SET held=false,owner=NULL WHERE owner=$1",
        ["different"],
      );
      expect(await gate("different")).toBeNull();
      await expect(seedSession(db, execution, "https://fixture.example")).rejects.toThrow(
        "DEPLOYMENT_GATED",
      );
      await db.query(
        "UPDATE browser_deployment_admission SET held=false,owner=NULL WHERE owner=$1",
        [owner],
      );
    });
    it("refuses on active work and admission races never produce both a held gate and new work", async () => {
      const session = await seedSession(db, execution, "https://fixture.example");
      expect(await gate("active")).toBeGreaterThan(0);
      const scope = (
        await db.query<any>(
          `SELECT s.project_id AS "projectId",s.mission_id AS "missionId",s.objective_id AS "objectiveId",s.agent_session_id AS "agentSessionId",s.environment_id AS "environmentId",r.flow_id AS "flowId",r.flow_revision_id AS "flowRevisionId",p.workspace_id AS "workspaceId" FROM browser_execution_sessions s JOIN runs r ON r.id=s.run_id JOIN projects p ON p.id=s.project_id WHERE s.id=$1`,
          [session],
        )
      ).rows[0];
      // These are relational metadata fixtures: no browser exists to retire.
      await db.query(
        "UPDATE browser_execution_sessions SET state='completed',terminal_at=now() WHERE id=$1",
        [session],
      );
      for (let i = 0; i < 20; i++) {
        const owner = randomUUID();
        const [deployment, start] = await Promise.allSettled([
          gate(owner),
          lifecycle.startRun(scope.workspaceId, {
            ...scope,
            idempotencyKey: randomUUID(),
            protectedInputIds: [],
            authenticationCommitLimit: 1,
            businessCommitLimit: 1,
          }),
        ]);
        expect(deployment.status).toBe("fulfilled");
        if (deployment.status === "fulfilled" && deployment.value === 0) {
          expect(start.status).toBe("rejected");
          await expect(
            commands.submit(session, {
              idempotencyKey: randomUUID(),
              command: { kind: "observe" },
            }),
          ).rejects.toThrow();
        }
        if (start.status === "fulfilled") {
          expect(deployment.status === "fulfilled" && deployment.value !== 0).toBe(true);
          await db.query(
            "UPDATE browser_execution_sessions SET state='completed',terminal_at=now() WHERE id=$1",
            [start.value.browserSessionId],
          );
        }
        await db.query(
          "UPDATE browser_deployment_admission SET held=false,owner=NULL WHERE owner=$1",
          [owner],
        );
      }
    });
  },
);
