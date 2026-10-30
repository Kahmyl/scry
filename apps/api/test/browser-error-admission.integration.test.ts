import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { seedSession } from "./fixtures/browser-session.js";
const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL,
  run = url ? describe : describe.skip;
run("database failure-disclosure boundary", () => {
  it("admits new safe failures and reads historical diagnostics without rewriting them", async () => {
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    const database = new Database(),
      cipher = new BrowserProtectedValueCipher(),
      commands = new BrowserCommandRepository(database, cipher),
      effects = new BrowserExecutionRepository(database, cipher);
    try {
      const session = await seedSession(database, effects, "https://fixture.example"),
        submitted = await commands.submit(session, {
          idempotencyKey: randomUUID(),
          command: { kind: "observe" },
        }),
        claim = await commands.claim(submitted.commandId);
      await commands.fail(
        submitted.commandId,
        claim!.claim_token!,
        new Error('elementHandle.fill: filling "fixture-only-password-a1b2c3"'),
      );
      const stored = await database.query<{ error_code: string }>(
        "SELECT error_code FROM browser_commands WHERE id=$1",
        [submitted.commandId],
      );
      expect(stored.rows[0]?.error_code).toBe("SCRY_BROWSER_COMMAND_FAILED");
      // Simulate pre-correction history in this disposable fixture database only.
      const legacy = "elementHandle_fill_fixture-only-password-a1b2c3";
      await database.query("UPDATE browser_commands SET error_code=$2 WHERE id=$1", [
        submitted.commandId,
        legacy,
      ]);
      expect((await commands.observe(submitted.commandId)).errorCode).toBe(
        "SCRY_BROWSER_COMMAND_FAILED",
      );
      const unchanged = await database.query<{ error_code: string }>(
        "SELECT error_code FROM browser_commands WHERE id=$1",
        [submitted.commandId],
      );
      expect(unchanged.rows[0]?.error_code).toBe(legacy);
      for (const code of [
        "SCRY_BROWSER_AUTHENTICATION_BUDGET_EXHAUSTED",
        "SCRY_BROWSER_BUSINESS_BUDGET_EXHAUSTED",
        `SCRY_BROWSER_EFFECT_UNRESOLVED:${randomUUID()}`,
        `SCRY_BROWSER_SESSION_INCOMPLETE:${randomUUID()}`,
      ]) {
        const next = await commands.submit(session, {
          idempotencyKey: randomUUID(),
          command: { kind: "observe" },
        });
        const nextClaim = await commands.claim(next.commandId);
        await commands.fail(next.commandId, nextClaim!.claim_token!, new Error(code));
        expect((await commands.observe(next.commandId)).errorCode).toBe(code);
        const row = await database.query<{ error_code: string }>(
          "SELECT error_code FROM browser_commands WHERE id=$1",
          [next.commandId],
        );
        expect(row.rows[0]?.error_code).toBe(code);
      }
    } finally {
      await database.onModuleDestroy();
    }
  });
});
