import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";

const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
run("durable per-session command order", () => {
  let database: Database;
  let commands: BrowserCommandRepository;
  let effects: BrowserExecutionRepository;
  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    database = new Database();
    const cipher = new BrowserProtectedValueCipher();
    commands = new BrowserCommandRepository(database, cipher);
    effects = new BrowserExecutionRepository(database, cipher);
  });
  afterAll(async () => database?.onModuleDestroy());
  const submit = async (sessionId: string) =>
    commands.submit(sessionId, { idempotencyKey: randomUUID(), command: { kind: "observe" } });

  it("does not claim a successor before its queued predecessor", async () => {
    const session = await seedSession(database, effects, "https://fixture.example");
    const first = await submit(session);
    const second = await submit(session);
    await expect(commands.claim(second.commandId)).rejects.toThrow(
      "SCRY_BROWSER_COMMAND_PREDECESSOR_PENDING",
    );
    const claimed = await commands.claim(first.commandId);
    expect(claimed?.claim_token).toBeTruthy();
    await expect(commands.claim(second.commandId)).rejects.toThrow(
      "SCRY_BROWSER_COMMAND_PREDECESSOR_PENDING",
    );
    await commands.complete(first.commandId, claimed!.claim_token!, { observed: true });
    expect((await commands.claim(second.commandId))?.id).toBe(second.commandId);
  });

  it("admits only one ordered command under concurrent claims", async () => {
    const session = await seedSession(database, effects, "https://fixture.example");
    const submitted = await Promise.all(Array.from({ length: 8 }, () => submit(session)));
    const results = await Promise.allSettled(
      submitted.map((value) => commands.claim(value.commandId)),
    );
    const admitted = results.filter((value) => value.status === "fulfilled" && value.value);
    expect(admitted).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(7);
    const order = await database.query<{ id: string }>(
      "SELECT id FROM browser_commands WHERE session_id=$1 ORDER BY command_ordinal LIMIT 1",
      [session],
    );
    expect(admitted[0]?.status === "fulfilled" && admitted[0].value?.id).toBe(order.rows[0]?.id);
  });

  it("keeps other sessions independent and advances after a failed predecessor", async () => {
    const a = await seedSession(database, effects, "https://fixture.example");
    const b = await seedSession(database, effects, "https://fixture.example");
    const first = await submit(a);
    const successor = await submit(a);
    const independent = await submit(b);
    const [left, right] = await Promise.all([
      commands.claim(first.commandId),
      commands.claim(independent.commandId),
    ]);
    expect(left?.claim_token).toBeTruthy();
    expect(right?.claim_token).toBeTruthy();
    await commands.fail(
      first.commandId,
      left!.claim_token!,
      new Error("SCRY_BROWSER_TEST_FAILURE"),
    );
    expect((await commands.claim(successor.commandId))?.id).toBe(successor.commandId);
    expect(await commands.claim(first.commandId)).toBeNull();
  });
});
