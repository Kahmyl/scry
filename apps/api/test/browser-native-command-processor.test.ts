import { performance } from "node:perf_hooks";
import { describe, it, expect, vi } from "vitest";
import type { PraxisExecutionPort } from "@scry/contracts";
import type { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { processBrowserCommand } from "../src/browser-execution/browser-command-processor.js";
describe("native command interruption reconciliation", () => {
  it.each([
    null,
    { execution: "completed", observation: "unavailable", businessOutcome: "unverified" },
  ])("never redispatches a reclaimed action (%j)", async (result) => {
    const sample = () => ({
      executionRemainingMs: 60000,
      claimRemainingMs: 60000,
      sampleStartedAt: performance.now(),
    });
    const commands = {
      claim: vi.fn(async () => ({
        id: "c",
        kind: "browser_tool",
        session_id: "s",
        claim_token: "claim",
        attempt_count: 2,
        safe_result: result,
        ...sample(),
      })),
      assertClaim: vi.fn(async () => sample()),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const praxis = { executeCommand: vi.fn() };
    const outcome = await processBrowserCommand(
      commands as unknown as BrowserCommandRepository,
      praxis as unknown as PraxisExecutionPort,
      { data: { commandId: "c" }, moveToDelayed: vi.fn() },
    );
    expect(praxis.executeCommand).not.toHaveBeenCalled();
    expect(commands.fail).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ execution: result ? "completed" : "unknown", recovered: true });
    expect(commands.complete).toHaveBeenCalledWith("c", "claim", outcome);
  });
});
