import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";

const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live = url ? describe : describe.skip;
live("post-lock browser owner authority", () => {
  let database: Database, effects: BrowserExecutionRepository, commands: BrowserCommandRepository;
  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    database = new Database();
    const cipher = new BrowserProtectedValueCipher();
    effects = new BrowserExecutionRepository(database, cipher);
    commands = new BrowserCommandRepository(database, cipher);
  });
  afterAll(async () => {
    vi.useRealTimers();
    await database?.onModuleDestroy();
  });
  const session = () => seedSession(database, effects, "https://fixture.example");
  const owned = async () => {
    const sessionId = await session();
    return { sessionId, ...(await effects.claimOwner(sessionId, "clock-fixture", 60_000)) };
  };
  const admitted = async () => {
    const owner = await owned();
    const { effect } = await effects.admitEffect({
      sessionId: owner.sessionId,
      ownerGeneration: owner.generation,
      documentEpoch: 1,
      idempotencyKey: randomUUID(),
      effectClass: "authentication",
      expectedOrigin: "https://fixture.example",
      targetDigest: "a".repeat(64),
      actionDigest: "b".repeat(64),
      intentSummary: "sign in",
    });
    return { owner, effect };
  };
  it.each(["dispatch", "publication"] as const)(
    "locks session and owner before effect for %s, matching owner replacement",
    async (operation) => {
      const { owner, effect } = await admitted();
      const client = await database.pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await client.query("BEGIN");
        const {
          rows: [row],
        } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await client.query("SELECT 1 FROM browser_execution_sessions WHERE id=$1 FOR UPDATE", [
          owner.sessionId,
        ]);
        await client.query(
          "SELECT 1 FROM browser_owner_generations WHERE session_id=$1 FOR UPDATE",
          [owner.sessionId],
        );
        pending =
          operation === "dispatch"
            ? effects.markDispatchStarted(effect.id, owner.generation)
            : effects.publishOutputs({
                effectId: effect.id,
                ownerGeneration: owner.generation,
                captureId: randomUUID(),
                selectionDigest: "c".repeat(64),
                publicOutputs: {},
                protectedOutputs: {},
                decisions: [],
              });
        void pending.catch(() => undefined);
        let blocked = false;
        for (let n = 0; n < 100; n++) {
          const wait = await database.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
            [row!.pid],
          );
          if (wait.rowCount) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        // No deadlock timeout or chosen victim is required for the oracle:
        // if the contender held the effect while waiting for our owner lock,
        // this NOWAIT acquisition would fail with 55P03.
        await client.query("SELECT 1 FROM browser_effects WHERE id=$1 FOR UPDATE NOWAIT", [
          effect.id,
        ]);
        await client.query("COMMIT");
        if (operation === "publication")
          await expect(pending).rejects.toThrow("CAPTURE_NOT_DURABLE");
        else await pending;
      } finally {
        await client.query("ROLLBACK");
        client.release();
        await pending?.catch(() => undefined);
      }
    },
  );
  it("preserves valid owner renewal, protected checkpoint and evidence admission", async () => {
    const owner = await owned();
    await effects.heartbeatOwner(owner.sessionId, owner.generation, owner.leaseToken, 60_000);
    expect(await effects.withOwner(owner, async () => "admitted")).toBe("admitted");
    expect(
      await commands.saveBrowserCheckpoint(owner.sessionId, owner.generation, {
        resumeUrl: "https://fixture.example/",
        storageState: { cookies: [], origins: [] },
        sessionStorage: {},
      }),
    ).toEqual({ revision: 1 });
  });
  it("starts the replacement lease after reconciliation, not before its effect-lock wait", async () => {
    const { owner, effect } = await admitted();
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
      [owner.sessionId],
    );
    const client = await database.pool.connect();
    let replacement: ReturnType<BrowserExecutionRepository["claimOwner"]> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM browser_effects WHERE id=$1 FOR UPDATE", [effect.id]);
      replacement = effects.claimOwner(owner.sessionId, "replacement", 1000);
      void replacement.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await client.query("COMMIT");
      const receipt = await replacement;
      expect(receipt.generation).toBe(owner.generation + 1);
      const result = await database.query<{ remaining: number }>(
        "SELECT EXTRACT(EPOCH FROM(lease_expires_at-clock_timestamp()))::float8*1000 AS remaining FROM browser_owner_generations WHERE session_id=$1 AND generation=$2",
        [owner.sessionId, receipt.generation],
      );
      expect(result.rows[0]!.remaining).toBeGreaterThan(500);
      const settled = await database.query(
        "SELECT mutation_outcome,determination_source FROM browser_effects WHERE id=$1",
        [effect.id],
      );
      expect(settled.rows[0]).toEqual({
        mutation_outcome: "not_applied",
        determination_source: "owner_replaced_before_dispatch",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await replacement?.catch(() => undefined);
    }
  });
  it("rejects the wrong owner token without renewing or entering evidence work", async () => {
    const owner = await owned();
    await expect(
      effects.heartbeatOwner(owner.sessionId, owner.generation, randomUUID(), 60_000),
    ).rejects.toThrow("OWNER_FENCED");
    await expect(
      effects.withOwner({ ...owner, leaseToken: randomUUID() }, async () => "invalid"),
    ).rejects.toThrow("OWNER_FENCED");
    expect(await effects.withOwner(owner, async () => "valid")).toBe("valid");
  });
  it("rejects an effect transition when its generation is no longer the session's active generation", async () => {
    const { owner, effect } = await admitted();
    await database.query(
      "UPDATE browser_execution_sessions SET active_owner_generation=$2 WHERE id=$1",
      [owner.sessionId, owner.generation + 1],
    );
    await expect(effects.markDispatchStarted(effect.id, owner.generation)).rejects.toThrow(
      "OWNER_FENCED",
    );
  });
  async function contend<T>(
    sessionId: string,
    table: "browser_owner_generations" | "browser_execution_sessions",
    work: () => Promise<T>,
  ): Promise<T> {
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=clock_timestamp()+interval '120 milliseconds' WHERE session_id=$1 AND state='active'",
      [sessionId],
    );
    const client = await database.pool.connect();
    let pending: Promise<T> | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT 1 FROM ${table} WHERE ${table === "browser_owner_generations" ? "session_id" : "id"}=$1 FOR UPDATE`,
        [sessionId],
      );
      pending = work();
      void pending.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 220));
      await client.query("COMMIT");
      return await pending;
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pending?.catch(() => undefined);
    }
  }
  it("does not steal a live database owner when the application wall clock is ahead", async () => {
    const owner = await owned();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 86_400_000);
    try {
      await expect(effects.claimOwner(owner.sessionId, "skewed", 60_000)).rejects.toThrow(
        "OWNER_ACTIVE",
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not create an already-expired owner when the application wall clock is behind", async () => {
    const id = await session();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 86_400_000);
    try {
      await effects.claimOwner(id, "skewed", 60_000);
    } finally {
      vi.useRealTimers();
    }
    const row = await database.query<{ remaining: number }>(
      "SELECT EXTRACT(EPOCH FROM(lease_expires_at-clock_timestamp()))::float8 AS remaining FROM browser_owner_generations WHERE session_id=$1",
      [id],
    );
    expect(row.rows[0]!.remaining).toBeGreaterThan(59);
    expect(row.rows[0]!.remaining).toBeLessThanOrEqual(60);
  });
  it("cannot heartbeat a lease that expired during an owner-row lock wait", async () => {
    const owner = await owned();
    await expect(
      contend(owner.sessionId, "browser_owner_generations", () =>
        effects.heartbeatOwner(owner.sessionId, owner.generation, owner.leaseToken, 60_000),
      ),
    ).rejects.toThrow("OWNER_FENCED");
  });
  it("cannot admit evidence work after expiry during an owner-row lock wait", async () => {
    const owner = await owned();
    let entered = false;
    await expect(
      contend(owner.sessionId, "browser_owner_generations", () =>
        effects.withOwner(owner, async () => {
          entered = true;
        }),
      ),
    ).rejects.toThrow("OWNER_FENCED");
    expect(entered).toBe(false);
  });
  it("cannot admit an effect after expiry during a session-row lock wait", async () => {
    const owner = await owned();
    await expect(
      contend(owner.sessionId, "browser_execution_sessions", () =>
        effects.admitEffect({
          sessionId: owner.sessionId,
          ownerGeneration: owner.generation,
          documentEpoch: 1,
          idempotencyKey: randomUUID(),
          effectClass: "authentication",
          expectedOrigin: "https://fixture.example",
          targetDigest: "a".repeat(64),
          actionDigest: "b".repeat(64),
          intentSummary: "sign in",
        }),
      ),
    ).rejects.toThrow("OWNER_FENCED");
  });
  it("cannot save a checkpoint after expiry during a session-row lock wait", async () => {
    const owner = await owned();
    await expect(
      contend(owner.sessionId, "browser_execution_sessions", () =>
        commands.saveBrowserCheckpoint(owner.sessionId, owner.generation, {
          resumeUrl: "https://fixture.example/",
          storageState: { cookies: [], origins: [] },
          sessionStorage: {},
        }),
      ),
    ).rejects.toThrow("OWNER_FENCED");
  });
  it.each([NaN, Infinity, 999, 300_001, 1.5])(
    "rejects invalid owner lease %s on creation and renewal",
    async (lease) => {
      const owner = await owned();
      await expect(effects.claimOwner(owner.sessionId, "invalid", lease)).rejects.toThrow(
        "OWNER_LEASE_INVALID",
      );
      await expect(
        effects.heartbeatOwner(owner.sessionId, owner.generation, owner.leaseToken, lease),
      ).rejects.toThrow("OWNER_LEASE_INVALID");
    },
  );
});
