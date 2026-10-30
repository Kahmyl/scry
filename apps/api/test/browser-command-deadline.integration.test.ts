import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserCommand } from "@scry/contracts";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";

const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live = url ? describe : describe.skip;
live("durable command deadline facts", () => {
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
  const submit = async (command: BrowserCommand = { kind: "observe" }) => {
    const session = await seedSession(database, effects, "https://fixture.example");
    return commands.submit(session, { idempotencyKey: randomUUID(), command });
  };
  it("assigns a finite routine budget on first claim, never while waiting in the queue", async () => {
    const { commandId } = await submit();
    const queued = await database.query(
      "SELECT execution_deadline_at,execution_budget_ms FROM browser_commands WHERE id=$1",
      [commandId],
    );
    expect(queued.rows[0]).toEqual({ execution_deadline_at: null, execution_budget_ms: null });
    const row = (await commands.claim(commandId))!;
    expect(row.execution_budget_ms).toBe(120000);
    expect(row.execution_deadline_at).toBeInstanceOf(Date);
    expect(row.execution_remaining_ms).toBeGreaterThan(119000);
    expect(row.execution_remaining_ms).toBeLessThanOrEqual(120000);
  });
  it.each(["close", "close_for_failure"] as const)(
    "assigns the separately bounded legacy %s budget",
    async (kind) => {
      const { commandId } = await submit({ kind });
      const row = (await commands.claim(commandId))!;
      expect(row.execution_budget_ms).toBe(900000);
      expect(row.execution_remaining_ms).toBeGreaterThan(899000);
      expect(row.execution_remaining_ms).toBeLessThanOrEqual(900000);
    },
  );
  it("preserves the first deadline and budget across an expired-lease retry", async () => {
    const { commandId } = await submit();
    const first = (await commands.claim(commandId))!;
    await database.query(
      "UPDATE browser_commands SET claim_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [commandId],
    );
    await database.query("SELECT pg_sleep(0.04)");
    const second = (await commands.claim(commandId))!;
    expect(second.execution_deadline_at).toEqual(first.execution_deadline_at);
    expect(second.execution_budget_ms).toBe(first.execution_budget_ms);
    expect(second.execution_remaining_ms).toBeLessThan(first.execution_remaining_ms);
    expect(second.attempt_count).toBe(2);
    expect(second.claim_token).not.toBe(first.claim_token);
  });
  it("reports zero remaining time without silently renewing an already expired deadline", async () => {
    const { commandId } = await submit();
    await database.query(
      "UPDATE browser_commands SET execution_deadline_at=clock_timestamp()-interval '1 second',execution_budget_ms=120000 WHERE id=$1",
      [commandId],
    );
    const before = (
      await database.query("SELECT execution_deadline_at FROM browser_commands WHERE id=$1", [
        commandId,
      ])
    ).rows[0];
    const row = (await commands.claim(commandId))!;
    expect(row.execution_deadline_at).toEqual(before!.execution_deadline_at);
    expect(row.execution_remaining_ms).toBe(0);
  });
  it("does not use the worker wall clock to decide whether another claim is still live", async () => {
    const { commandId } = await submit();
    await commands.claim(commandId);
    const original = Date.now;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => original() + 86400000);
    try {
      await expect(commands.claim(commandId)).rejects.toThrow("COMMAND_ALREADY_RUNNING");
    } finally {
      clock.mockRestore();
    }
  });
  it("rejects clearing, extending or changing assigned deadline facts and malformed pairs", async () => {
    const { commandId } = await submit();
    await commands.claim(commandId);
    for (const assignment of [
      "execution_deadline_at=NULL,execution_budget_ms=NULL",
      "execution_deadline_at=execution_deadline_at+interval '1 hour'",
      "execution_budget_ms=execution_budget_ms+1",
    ])
      await expect(
        database.query(`UPDATE browser_commands SET ${assignment} WHERE id=$1`, [commandId]),
      ).rejects.toThrow("command_deadline_immutable");
    const { commandId: queued } = await submit();
    for (const assignment of [
      "execution_deadline_at=clock_timestamp()",
      "execution_budget_ms=120000",
      "execution_deadline_at='infinity',execution_budget_ms=120000",
      "execution_deadline_at=clock_timestamp(),execution_budget_ms=0",
      "execution_deadline_at=clock_timestamp(),execution_budget_ms=900001",
    ])
      await expect(
        database.query(`UPDATE browser_commands SET ${assignment} WHERE id=$1`, [queued]),
      ).rejects.toThrow();
    const row = (await commands.claim(queued))!;
    await commands.complete(queued, row.claim_token!, { observed: true });
    expect(
      (
        await database.query("SELECT execution_deadline_at FROM browser_commands WHERE id=$1", [
          queued,
        ])
      ).rows[0]!.execution_deadline_at,
    ).toEqual(row.execution_deadline_at);
  });
});
