import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SupervisedBrowser } from "@scry/praxis";
import { AuthenticatedEvidenceStore } from "@scry/chronicle";
import { composePraxisExecutionPort } from "../src/browser-execution/browser-boundary-composition.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";

const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live = url && process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;
live("confirmed native owner retirement", () => {
  let database: Database;
  const launched = vi.spyOn(SupervisedBrowser, "launch");
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    process.env.SCRY_BROWSER_RENDER_VIDEO = "false";
    process.env.SCRY_BROWSER_ARTIFACT_ROOT = await mkdtemp(
      path.join(os.tmpdir(), "scry-retirement-"),
    );
    database = new Database();
  });
  afterAll(async () => {
    launched.mockRestore();
    await database?.onModuleDestroy();
  });
  it("does not release its durable owner while an actual Chronicle append is still unsettled", async () => {
    const cipher = new BrowserProtectedValueCipher(),
      effects = new BrowserExecutionRepository(database, cipher);
    const praxis = composePraxisExecutionPort(
      new BrowserCommandRepository(database, cipher),
      effects,
    );
    let finish!: () => void, enter!: () => void;
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
    const append = AuthenticatedEvidenceStore.prototype.append;
    const held = vi
      .spyOn(AuthenticatedEvidenceStore.prototype, "append")
      .mockImplementationOnce(async function (
        this: AuthenticatedEvidenceStore<unknown>,
        payload: unknown,
      ) {
        enter();
        await gate;
        return append.call(this, payload);
      });
    const retirement = vi.spyOn(effects, "retireOwner");
    const id = await seedSession(database, effects, "https://fixture.example");
    let stopping: Promise<void> | undefined;
    let closing: Promise<unknown> | undefined;
    try {
      const owner = await praxis.openSession(id);
      // Native capture admits a file at an action checkpoint/close, not a DOM
      // snapshot on startup. Hold that real native receipt's Chronicle append.
      closing = praxis.executeCommand(id, { kind: "close" });
      void closing.catch(() => undefined);
      await vi.waitFor(() => expect(held).toHaveBeenCalledTimes(1), { timeout: 3000 });
      await entered;
      const browser = await launched.mock.results.at(-1)!.value;
      stopping = praxis.shutdown();
      void stopping.catch(() => undefined);
      await vi.waitFor(
        () => {
          expect(browser.exitConfirmed).toBe(true);
          expect(browser.browser.isConnected()).toBe(false);
        },
        { timeout: 6000 },
      );
      // Drain the protocol-close microtasks, not a guessed recording delay.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(retirement).not.toHaveBeenCalled();
      const before = await database.query(
        "SELECT state FROM browser_owner_generations WHERE session_id=$1 AND generation=$2",
        [id, owner.ownerGeneration],
      );
      expect(before.rows[0]!.state).toBe("active");
      finish();
      await stopping;
      expect(retirement).toHaveBeenCalledTimes(1);
      expect(
        (
          await database.query(
            "SELECT state FROM browser_owner_generations WHERE session_id=$1 AND generation=$2",
            [id, owner.ownerGeneration],
          )
        ).rows[0]!.state,
      ).toBe("released");
    } finally {
      finish();
      await stopping?.catch(() => undefined);
      await closing?.catch(() => undefined);
      await praxis.shutdown();
      held.mockRestore();
      retirement.mockRestore();
    }
  }, 20000);
  it.each(["not_started", "started"] as const)(
    "reconciles %s work and permits immediate replacement only after actual browser exit",
    async (dispatch) => {
      const cipher = new BrowserProtectedValueCipher(),
        effects = new BrowserExecutionRepository(database, cipher);
      const praxis = composePraxisExecutionPort(
        new BrowserCommandRepository(database, cipher),
        effects,
      );
      const id = await seedSession(database, effects, "https://fixture.example");
      try {
        const owner = await praxis.openSession(id);
        const { effect } = await effects.admitEffect({
          sessionId: id,
          ownerGeneration: owner.ownerGeneration,
          documentEpoch: 1,
          idempotencyKey: randomUUID(),
          effectClass: "authentication",
          expectedOrigin: "https://fixture.example",
          targetDigest: "a".repeat(64),
          actionDigest: "b".repeat(64),
          intentSummary: "retirement fixture intent",
        });
        if (dispatch === "started")
          await effects.markDispatchStarted(effect.id, owner.ownerGeneration);
        const browser = await launched.mock.results.at(-1)!.value;
        await praxis.shutdown();
        expect(browser.exitConfirmed).toBe(true);
        const row = await database.query(
          "SELECT state FROM browser_owner_generations WHERE session_id=$1 AND generation=$2",
          [id, owner.ownerGeneration],
        );
        expect(row.rows[0]!.state).toBe("released");
        const fact = await database.query(
          "SELECT mutation_outcome,determination_source FROM browser_effects WHERE id=$1",
          [effect.id],
        );
        expect(fact.rows[0]).toEqual({
          mutation_outcome: dispatch === "started" ? "unknown" : "not_applied",
          determination_source:
            dispatch === "started"
              ? "owner_retired_after_dispatch"
              : "owner_retired_before_dispatch",
        });
        expect((await effects.claimOwner(id, "replacement", 60000)).generation).toBe(
          owner.ownerGeneration + 1,
        );
        const budget = await database.query(
          "SELECT authentication_commits_used FROM browser_execution_sessions WHERE id=$1",
          [id],
        );
        expect(budget.rows[0]!.authentication_commits_used).toBe(dispatch === "started" ? 1 : 0);
        const evidence = await database.query(
          "SELECT completed_at FROM browser_evidence_streams WHERE session_id=$1",
          [id],
        );
        expect(evidence.rows.every((row) => row.completed_at === null)).toBe(true);
      } finally {
        await praxis.shutdown();
      }
    },
  );
});
