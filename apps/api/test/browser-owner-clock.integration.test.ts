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
