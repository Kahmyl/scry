import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { BrowserLifecycleRepository } from "../src/browser-execution/repositories/browser-lifecycle.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserRuntimeVeilReportProtection } from "../src/browser-execution/browser-boundary-composition.js";
import { seedSession } from "./fixtures/browser-session.js";
import { prepareBrowserJourneySchema } from "@scry/contracts";

const target = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(target ? describe : describe.skip)(
  "atomic journey preparation through the real lifecycle repository",
  () => {
    let db: Database, repo: BrowserLifecycleRepository;
    beforeAll(() => {
      vi.stubEnv("DATABASE_URL", target!);
      vi.stubEnv("SCRY_BROWSER_MAX_LIVE_SESSIONS", "1000");
      vi.stubEnv("SCRY_BROWSER_PROTECTED_KEY_BASE64", randomBytes(32).toString("base64"));
      db = new Database();
      repo = new BrowserLifecycleRepository(db, new BrowserRuntimeVeilReportProtection());
    });
    afterAll(async () => {
      await db?.onModuleDestroy();
      vi.unstubAllEnvs();
    });
    async function fixture() {
      const id = await seedSession(
        db,
        new BrowserExecutionRepository(db, new BrowserProtectedValueCipher()),
        "https://fixture.example",
      );
      const scope = (
        await db.query<{
          projectId: string;
          missionId: string;
          agentSessionId: string;
          environmentId: string;
          workspaceId: string;
        }>(
          `SELECT s.project_id AS "projectId",s.mission_id AS "missionId",s.agent_session_id AS "agentSessionId",s.environment_id AS "environmentId",p.workspace_id AS "workspaceId"
       FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=$1`,
          [id],
        )
      ).rows[0]!;
      const { workspaceId, ...ids } = scope;
      return {
        workspaceId,
        input: prepareBrowserJourneySchema.parse({
          ...ids,
          attemptId: randomUUID(),
          title: "Fictional journey",
          objectiveOrder: 1,
          completionCriteria: { persisted: true },
        }),
      };
    }
    const counts = async (missionId: string) =>
      (
        await db.query(
          `SELECT (SELECT count(*)::int FROM mission_objectives WHERE mission_id=$1) AS objectives,
     (SELECT count(*)::int FROM flows WHERE mission_id=$1) AS flows,
     (SELECT count(*)::int FROM runs WHERE mission_id=$1) AS runs,
     (SELECT count(*)::int FROM browser_journey_receipts WHERE mission_id=$1) AS receipts`,
          [missionId],
        )
      ).rows[0];
    it("creates one complete setup and exact concurrent retries return the same receipt", async () => {
      const f = await fixture();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => repo.prepareJourney(f.workspaceId, f.input)),
      );
      expect(new Set(results.map((r) => r.runId)).size).toBe(1);
      expect(results.filter((r) => r.replay === false)).toHaveLength(1);
      expect(await counts(f.input.missionId)).toEqual({
        objectives: 2,
        flows: 2,
        runs: 2,
        receipts: 1,
      });
      const row = (
        await db.query(
          "SELECT count(*)::int AS n FROM browser_execution_outbox WHERE session_id=$1",
          [results[0]!.browserSessionId],
        )
      ).rows[0];
      expect(row!.n).toBe(1);
    });
    it("rolls back Objective and Flow when the assigned Environment is invalid", async () => {
      const f = await fixture(),
        before = await counts(f.input.missionId);
      await expect(
        repo.prepareJourney(f.workspaceId, { ...f.input, environmentId: randomUUID() }),
      ).rejects.toThrow("ENVIRONMENT_NOT_FOUND");
      expect(await counts(f.input.missionId)).toEqual(before);
    });
    it("rolls back setup on capacity refusal without weakening admission", async () => {
      const f = await fixture(),
        before = await counts(f.input.missionId);
      vi.stubEnv("SCRY_BROWSER_MAX_LIVE_SESSIONS", "1");
      try {
        await expect(repo.prepareJourney(f.workspaceId, f.input)).rejects.toThrow(
          "CAPACITY_EXHAUSTED",
        );
      } finally {
        vi.stubEnv("SCRY_BROWSER_MAX_LIVE_SESSIONS", "1000");
      }
      expect(await counts(f.input.missionId)).toEqual(before);
    });
    it("rejects changed semantics on the same attempt and rechecks workspace on replay", async () => {
      const f = await fixture();
      await repo.prepareJourney(f.workspaceId, f.input);
      await expect(
        repo.prepareJourney(f.workspaceId, { ...f.input, title: "Changed" }),
      ).rejects.toThrow("ATTEMPT_CONFLICT");
      await expect(repo.prepareJourney(randomUUID(), f.input)).rejects.toThrow();
      expect(await counts(f.input.missionId)).toEqual({
        objectives: 2,
        flows: 2,
        runs: 2,
        receipts: 1,
      });
    });
    it("normalizes defaults before hashing and snapshots caller input before awaits", async () => {
      const f = await fixture(),
        mutable = structuredClone(f.input);
      const pending = repo.prepareJourney(f.workspaceId, mutable);
      mutable.title = "Changed after admission";
      await pending;
      const omitted: any = { ...f.input };
      delete omitted.protectedInputIds;
      delete omitted.authenticationCommitLimit;
      delete omitted.businessCommitLimit;
      delete omitted.purpose;
      delete omitted.contractVersion;
      expect((await repo.prepareJourney(f.workspaceId, omitted)).replay).toBe(true);
    });
    it("bounds a blocked metadata transaction without leaving partial writes", async () => {
      const f = await fixture(),
        before = await counts(f.input.missionId);
      const lock = await db.pool.connect();
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `journey:${f.input.missionId}:${f.input.attemptId}`,
      ]);
      const start = performance.now();
      try {
        await expect(
          db.boundedTransaction(async (c) => {
            await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              `journey:${f.input.missionId}:${f.input.attemptId}`,
            ]);
          }, 40),
        ).rejects.toThrow();
        expect(performance.now() - start).toBeLessThan(500);
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
      }
      expect(await counts(f.input.missionId)).toEqual(before);
    });
  },
);
