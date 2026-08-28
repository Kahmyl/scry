import { describe, expect, it, vi } from "vitest";

import { AdaptiveSessionKernelRunner } from "../src/adaptive-sessions/adaptive-session-kernel.runner.js";
import {
  FailpointController,
  Q2InjectedFault,
} from "../../../packages/assurance/src/architecture/q2/failpoints.js";
import {
  runQ2Scenario,
  q2SafeScope,
} from "../../../packages/assurance/src/architecture/q2/runner.js";
import { q2Scenarios } from "../../../packages/assurance/src/architecture/q2/scenarios.js";

describe("Q2 B19 production-shaped runtime close fault", () => {
  it("characterizes close succeeding before durable lease release rejects", async () => {
    const scenario = q2Scenarios.find(({ boundary }) => boundary === "B19")!;
    const failpoints = FailpointController.approvedTestComposition([scenario.failpoint]);
    const close = vi.fn(async () => undefined);
    const releaseRuntimeLease = vi.fn(async () =>
      failpoints.atBoundary(scenario.failpoint.name, q2SafeScope),
    );
    const runner = new AdaptiveSessionKernelRunner(
      {} as never,
      {} as never,
      { releaseRuntimeLease } as never,
      {} as never,
    );
    const sessionId = "99999999-9999-4999-8999-999999999999";
    (runner as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId, {
      session: { close },
      fencingToken: 19,
      tail: Promise.resolve(),
    });

    await expect(runner.close(sessionId)).rejects.toBeInstanceOf(Q2InjectedFault);

    expect(close).toHaveBeenCalledOnce();
    expect(releaseRuntimeLease).toHaveBeenCalledWith({
      sessionId,
      ownerId: expect.any(String),
      fencingToken: 19,
    });
    expect((runner as unknown as { runtimes: Map<string, unknown> }).runtimes.has(sessionId)).toBe(
      false,
    );
    expect(failpoints.ledger()).toEqual([
      expect.objectContaining({ boundary: "B19", effect: "close_runtime" }),
    ]);
    expect(runQ2Scenario(scenario).violations.map(({ invariantId }) => invariantId)).toEqual([
      "L04",
    ]);
  });
});
