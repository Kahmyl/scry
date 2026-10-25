import { describe, expect, it, vi } from "vitest";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserExceptionFilter } from "../src/browser-execution/browser-exception.filter.js";
import type { Database } from "../src/infrastructure/database.js";
import type { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import type { ArgumentsHost } from "@nestjs/common";
describe("durable and public failure admission", () => {
  it("sanitizes historical raw failure reads without rewriting history", async () => {
    const legacy = {
        id: "command",
        state: "failed",
        errorCode: "elementHandle_fill_fixture-only-password-a1b2c3",
        result: null,
      },
      query = vi.fn().mockResolvedValue({ rows: [legacy] });
    const commands = new BrowserCommandRepository(
      { query } as unknown as Database,
      {} as BrowserProtectedValueCipher,
    );
    expect(await commands.observe("command")).toMatchObject({
      errorCode: "SCRY_BROWSER_COMMAND_FAILED",
    });
    expect(legacy.errorCode).toContain("fixture-only-password");
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("never stores driver values in failure/outbox codes", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      db = { query } as unknown as Database,
      cipher = {} as BrowserProtectedValueCipher;
    await new BrowserCommandRepository(db, cipher).fail(
      "command",
      "claim",
      new Error('elementHandle.fill: filling "fixture-only-password-a1b2c3"'),
    );
    expect(query.mock.calls[0]?.[1]).toEqual(["command", "claim", "SCRY_BROWSER_COMMAND_FAILED"]);
    await new BrowserExecutionRepository(db, cipher).markSessionPublishFailed(
      "session",
      "fixture-only-token-a1b2c3",
    );
    expect(query.mock.calls[1]?.[1]).toEqual(["session", "SCRY_BROWSER_COMMAND_FAILED"]);
  });
  it("does not accept an arbitrary uppercase browser prefix as HTTP-safe metadata", () => {
    const reply = { status: vi.fn(), send: vi.fn() };
    reply.status.mockReturnValue(reply);
    const host = { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ArgumentsHost;
    new BrowserExceptionFilter().catch(new Error("SCRY_BROWSER_PRIVATE_PASSWORD_A1B2C3"), host);
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain("PRIVATE_PASSWORD");
  });
});
