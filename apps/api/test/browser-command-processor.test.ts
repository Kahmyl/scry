import { DelayedError } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PraxisExecutionPort } from "@scry/contracts";
import type { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { processBrowserCommand } from "../src/browser-execution/browser-command-processor.js";

function fixture() {
  const commands = {
    claim: vi.fn(async () => ({
      id: "command",
      session_id: "session",
      claim_token: "fixture-claim",
      safe_input: { kind: "observe" },
    })),
    heartbeatClaim: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
  const praxis = { executeCommand: vi.fn(async () => ({ observed: true })) };
  const job = { data: { commandId: "command" }, moveToDelayed: vi.fn(async () => undefined) };
  const run = () =>
    processBrowserCommand(
      commands as unknown as BrowserCommandRepository,
      praxis as unknown as PraxisExecutionPort,
      job,
      "queue-lock",
    );
  return { commands, praxis, job, run };
}
afterEach(() => vi.useRealTimers());
describe("production command processor admission", () => {
  it.each(["SCRY_BROWSER_COMMAND_PREDECESSOR_PENDING", "SCRY_BROWSER_COMMAND_ALREADY_RUNNING"])(
    "defers %s without executing or failing the command",
    async (code) => {
      vi.useFakeTimers();
      const { commands, praxis, job, run } = fixture();
      commands.claim.mockRejectedValueOnce(new Error(code));
      await expect(run()).rejects.toBeInstanceOf(DelayedError);
      expect(job.moveToDelayed).toHaveBeenCalledWith(Date.now() + 1000, "queue-lock");
      expect(praxis.executeCommand).not.toHaveBeenCalled();
      expect(commands.complete).not.toHaveBeenCalled();
      expect(commands.fail).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("does not disguise database or queue transition failures as admission waits", async () => {
    const { commands, job, run } = fixture();
    commands.claim.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(run()).rejects.toThrow("database unavailable");
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    commands.claim.mockRejectedValueOnce(new Error("SCRY_BROWSER_COMMAND_PREDECESSOR_PENDING"));
    job.moveToDelayed.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(run()).rejects.toThrow("queue unavailable");
    expect(commands.fail).not.toHaveBeenCalled();
  });
  it("replays terminal commands without native dispatch", async () => {
    const { commands, praxis, run } = fixture();
    commands.claim.mockResolvedValueOnce(null as never);
    expect(await run()).toEqual({ replay: true });
    expect(praxis.executeCommand).not.toHaveBeenCalled();
  });
  it("completes with the exact claim and clears its heartbeat", async () => {
    vi.useFakeTimers();
    const { commands, run } = fixture();
    expect(await run()).toEqual({ observed: true });
    expect(commands.complete).toHaveBeenCalledWith("command", "fixture-claim", { observed: true });
    expect(commands.fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves native failures as command failures and clears its heartbeat", async () => {
    vi.useFakeTimers();
    const { commands, praxis, run } = fixture();
    const error = new Error("SCRY_BROWSER_TEST_FAILURE");
    praxis.executeCommand.mockRejectedValueOnce(error);
    expect(await run()).toEqual({ failed: true });
    expect(commands.fail).toHaveBeenCalledWith("command", "fixture-claim", error);
    expect(commands.complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
