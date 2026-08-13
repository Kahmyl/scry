import { describe, expect, it, vi } from "vitest";

import { AuthoringRuntimeCommandService } from "../src/authoring/authoring-runtime-command.service.js";

const principal = {
  kind: "service" as const,
  projectId: "11111111-1111-4111-8111-111111111111",
  serviceAccountId: "service",
  subject: "scry-service" as const,
};

describe("authoring runtime command service recovery", () => {
  it("returns a stale-claim terminal result on same-key retry instead of polling forever", async () => {
    const commands = {
      enqueue: vi.fn(async () => ({ id: "command", state: "failed", replayed: true })),
      result: vi.fn(async () => ({
        state: "failed",
        outcome: "failed",
        safeResult: null,
        safeError: {
          code: "AUTHORING_COMMAND_LEASE_LOST",
          mutationOutcome: "unknown",
          safeActions: ["reconcile_mutation", "do_not_retry"],
        },
      })),
    };
    const service = new AuthoringRuntimeCommandService(
      commands as never,
      {
        assertAcceptingWork: vi.fn(async () => undefined),
      } as never,
    );
    const startedAt = performance.now();
    await expect(
      service.advance(principal, crypto.randomUUID(), turnCommand()),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "AUTHORING_COMMAND_LEASE_LOST" }),
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(commands.result).toHaveBeenCalledOnce();
  });

  it("classifies a response deadline as unknown and names the same-request recovery", async () => {
    vi.useFakeTimers();
    const commands = {
      enqueue: vi.fn(async () => ({ id: "command", state: "queued", replayed: false })),
      result: vi.fn(async () => ({ state: "running" })),
    };
    const service = new AuthoringRuntimeCommandService(commands as never, {
      assertAcceptingWork: vi.fn(async () => undefined),
    } as never);
    const pending = service.advance(principal, crypto.randomUUID(), turnCommand());
    const assertion = expect(pending).rejects.toMatchObject({ response: expect.objectContaining({
      code: "AUTHORING_TURN_DEADLINE_EXCEEDED",
      mutationOutcome: "unknown",
      retry: "safe_same_idempotency_key",
      recoveryTool: "advance_flow_authoring",
      idempotencyReuse: "same_request_arguments",
    }) });
    await vi.advanceTimersByTimeAsync(16_100);
    await assertion;
    vi.useRealTimers();
  });
});

function turnCommand() {
  return {
    missionId: crypto.randomUUID(),
    agentSessionId: crypto.randomUUID(),
    idempotencyKey: "stale-command-retry",
    payload: {
      objectiveDelta: "Open the safe details page",
      operations: [
        {
          operationId: "open-details",
          action: { type: "navigate" as const, url: "https://example.test/details" },
          expectedEffect: { type: "navigation" as const, url: "/details", match: "path" as const },
        },
      ],
      authorization: { mutationAllowed: false, protectedOperationAllowed: false },
      budgets: { maxOperations: 1, maxDurationMs: 1_000, maxPreDispatchRetries: 0 },
      protectedInputReferences: [],
    },
  };
}
