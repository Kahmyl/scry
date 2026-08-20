import { describe, expect, it, vi } from "vitest";

import {
  ProtectedStageAbortedError,
  ProtectedStageTimeoutError,
  runProtectedStage,
} from "../src/protected-stage-supervisor.js";

describe("protected stage supervisor", () => {
  it("returns a result that settles before its deadline", async () => {
    await expect(
      runProtectedStage({
        stage: "test",
        timeoutMs: 50,
        timeoutCode: "TEST_TIMEOUT",
        dispatchPosition: "pre_dispatch",
        work: async () => "ok",
      }),
    ).resolves.toBe("ok");
  });

  it("terminates a promise that never settles", async () => {
    await expect(
      runProtectedStage({
        stage: "test",
        timeoutMs: 5,
        timeoutCode: "TEST_TIMEOUT",
        dispatchPosition: "post_dispatch",
        work: () => new Promise(() => undefined),
      }),
    ).rejects.toMatchObject({
      code: "TEST_TIMEOUT",
      dispatchPosition: "post_dispatch",
    });
  });

  it("does not admit a late result", async () => {
    const admitted = vi.fn();
    await expect(
      runProtectedStage({
        stage: "test",
        timeoutMs: 5,
        timeoutCode: "TEST_TIMEOUT",
        dispatchPosition: "post_dispatch",
        work: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return "late";
        },
      }).then(admitted),
    ).rejects.toBeInstanceOf(ProtectedStageTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(admitted).not.toHaveBeenCalled();
  });

  it("lets an AbortSignal terminate before the deadline", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort("lost"), 5);
    await expect(
      runProtectedStage({
        stage: "test",
        timeoutMs: 100,
        signal: controller.signal,
        timeoutCode: "TEST_TIMEOUT",
        dispatchPosition: "pre_dispatch",
        work: () => new Promise(() => undefined),
      }),
    ).rejects.toBeInstanceOf(ProtectedStageAbortedError);
  });

  it("lets the deadline terminate before a later AbortSignal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort("late"), 50);
    await expect(
      runProtectedStage({
        stage: "test",
        timeoutMs: 5,
        signal: controller.signal,
        timeoutCode: "TEST_TIMEOUT",
        dispatchPosition: "pre_dispatch",
        work: () => new Promise(() => undefined),
      }),
    ).rejects.toBeInstanceOf(ProtectedStageTimeoutError);
  });
});
