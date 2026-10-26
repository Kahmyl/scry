import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";
const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live = url ? describe : describe.skip;
live("post-lock command claim fencing", () => {
  it("records recovery-required diagnostics without pretending that unknown runtime work is terminal", async () => {
    const row = await claimed();
    await commands.noteRecoveryRequired(row.id, row.claim_token!);
    expect(await commands.observe(row.id)).toMatchObject({
      state: "running",
      errorCode: "SCRY_BROWSER_COMMAND_DRAIN_UNCONFIRMED",
    });
    const stored = await database.query(
      "SELECT claim_token,completed_at FROM browser_commands WHERE id=$1",
      [row.id],
    );
    expect(stored.rows[0]!.claim_token).toBe(row.claim_token);
    expect(stored.rows[0]!.completed_at).toBeNull();
    await expire(row.id);
    await expect(commands.noteRecoveryRequired(row.id, row.claim_token!)).rejects.toThrow(
      "COMMAND_CLAIM_FENCED",
    );
  });
  let database: Database, commands: BrowserCommandRepository, effects: BrowserExecutionRepository;
  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    database = new Database();
    const cipher = new BrowserProtectedValueCipher();
    commands = new BrowserCommandRepository(database, cipher);
    effects = new BrowserExecutionRepository(database, cipher);
  });
  afterAll(async () => database?.onModuleDestroy());
  const queued = async () => {
    const session = await seedSession(database, effects, "https://fixture.example");
    return commands.submit(session, { idempotencyKey: randomUUID(), command: { kind: "observe" } });
  };
  const claimed = async () => {
    const { commandId } = await queued();
    return (await commands.claim(commandId))!;
  };
  const expire = (id: string) =>
    database.query(
      "UPDATE browser_commands SET claim_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [id],
    );
  async function contend<T>(id: string, work: () => Promise<T>): Promise<T> {
    await database.query(
      "UPDATE browser_commands SET claim_lease_expires_at=clock_timestamp()+interval '120 milliseconds' WHERE id=$1",
      [id],
    );
    const client = await database.pool.connect();
    let pending: Promise<T> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM browser_commands WHERE id=$1 FOR UPDATE", [id]);
      pending = work();
      void pending.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await client.query("COMMIT");
      return await pending;
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pending?.catch(() => undefined);
    }
  }
  it("rejects completion by an expired claimant even without replacement", async () => {
    const row = await claimed();
    await expire(row.id);
    await expect(commands.complete(row.id, row.claim_token!, { observed: true })).rejects.toThrow(
      "COMMAND_COMPLETION_CONFLICT",
    );
    expect((await commands.observe(row.id)).state).toBe("running");
  });
  it("rejects failure by an expired claimant instead of clearing its recovery facts", async () => {
    const row = await claimed();
    await expire(row.id);
    await expect(
      commands.fail(row.id, row.claim_token!, new Error("SCRY_BROWSER_COMMAND_FAILED")),
    ).rejects.toThrow("COMMAND_CLAIM_FENCED");
    expect((await commands.observe(row.id)).state).toBe("running");
  });
  it("does not renew a claim after it expires while waiting on a row lock", async () => {
    const row = await claimed();
    await expect(
      contend(row.id, () => commands.heartbeatClaim(row.id, row.claim_token!)),
    ).rejects.toThrow("COMMAND_CLAIM_FENCED");
  });
  it("does not complete after its lease expires while waiting on a row lock", async () => {
    const row = await claimed();
    await expect(
      contend(row.id, () => commands.complete(row.id, row.claim_token!, { observed: true })),
    ).rejects.toThrow("COMMAND_COMPLETION_CONFLICT");
  });
  it("reclaims after lock wait using the current database clock rather than a pre-lock projection", async () => {
    const row = await claimed();
    const replacement = await contend(row.id, () => commands.claim(row.id));
    expect(replacement?.claim_token).not.toBe(row.claim_token);
    expect(replacement?.attempt_count).toBe(2);
  });
  it("rejects success after the durable deadline but permits failure under the still-live claim", async () => {
    const { commandId } = await queued();
    await database.query(
      "UPDATE browser_commands SET execution_deadline_at=clock_timestamp()-interval '1 second',execution_budget_ms=120000 WHERE id=$1",
      [commandId],
    );
    const row = (await commands.claim(commandId))!;
    await expect(commands.complete(row.id, row.claim_token!, { observed: true })).rejects.toThrow(
      "COMMAND_COMPLETION_CONFLICT",
    );
    await commands.fail(
      row.id,
      row.claim_token!,
      new Error("SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED"),
    );
    expect(await commands.observe(row.id)).toMatchObject({
      state: "failed",
      errorCode: "SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED",
    });
  });
  it("returns database-relative lease and deadline samples and refuses stale pre-dispatch checks", async () => {
    const row = await claimed();
    const sample = await commands.assertClaim(row.id, row.claim_token!);
    expect(sample.claimRemainingMs).toBeGreaterThan(59000);
    expect(sample.claimRemainingMs).toBeLessThanOrEqual(60000);
    expect(sample.executionRemainingMs).toBeGreaterThan(119000);
    await expect(
      contend(row.id, () => commands.assertClaim(row.id, row.claim_token!)),
    ).rejects.toThrow("COMMAND_CLAIM_FENCED");
  });
  it("does not permit an old token to heartbeat, check, complete or fail after replacement", async () => {
    const row = await claimed();
    await expire(row.id);
    const replacement = (await commands.claim(row.id))!;
    await expect(commands.heartbeatClaim(row.id, row.claim_token!)).rejects.toThrow(
      "COMMAND_CLAIM_FENCED",
    );
    await expect(commands.assertClaim(row.id, row.claim_token!)).rejects.toThrow(
      "COMMAND_CLAIM_FENCED",
    );
    await expect(commands.complete(row.id, row.claim_token!, {})).rejects.toThrow(
      "COMMAND_COMPLETION_CONFLICT",
    );
    await expect(
      commands.fail(row.id, row.claim_token!, new Error("SCRY_BROWSER_COMMAND_FAILED")),
    ).rejects.toThrow("COMMAND_CLAIM_FENCED");
    await commands.complete(row.id, replacement.claim_token!, { observed: true });
    expect((await commands.observe(row.id)).state).toBe("completed");
  });
  it("validates heartbeat limits before renewal and leaves terminal work immutable", async () => {
    const row = await claimed();
    for (const leaseMs of [0, 29999, 300001, NaN])
      await expect(commands.heartbeatClaim(row.id, row.claim_token!, leaseMs)).rejects.toThrow(
        "COMMAND_LEASE_INVALID",
      );
    const sample = await commands.heartbeatClaim(row.id, row.claim_token!);
    expect(sample.claimRemainingMs).toBeGreaterThan(59000);
    await commands.complete(row.id, row.claim_token!, { observed: true });
    await expect(commands.heartbeatClaim(row.id, row.claim_token!)).rejects.toThrow(
      "COMMAND_CLAIM_FENCED",
    );
    await expect(
      commands.fail(row.id, row.claim_token!, new Error("SCRY_BROWSER_COMMAND_FAILED")),
    ).rejects.toThrow("COMMAND_CLAIM_FENCED");
  });
});
