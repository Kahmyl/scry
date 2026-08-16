import { describe, expect, it, vi } from "vitest";

import {
  bindProtectedInputDelivery,
  ProtectedInputDeliveryError,
  type ProtectedInputDeliveryBinding,
} from "../src/adaptive-sessions/protected-input-capability.js";

const binding: ProtectedInputDeliveryBinding = {
  sessionId: "session-a",
  operationId: "operation-a",
  protectedReferenceId: "credential-a",
  targetReference: "context-control-a",
};

describe("protected input delivery capability", () => {
  it("delivers only for the exact live-session operation and pinned target binding", async () => {
    const resolve = vi.fn(async () => "protected-test-value");
    const capability = bindProtectedInputDelivery(binding, resolve);

    await expect(capability.consume(binding)).resolves.toBe("protected-test-value");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  for (const [name, mismatch] of [
    ["session", { sessionId: "session-b" }],
    ["operation", { operationId: "operation-b" }],
    ["protected reference", { protectedReferenceId: "credential-b" }],
    ["target reference", { targetReference: "context-control-b" }],
  ] as const) {
    it(`refuses a wrong ${name} without resolving plaintext`, async () => {
      const resolve = vi.fn(async () => "must-not-resolve");
      const capability = bindProtectedInputDelivery(binding, resolve);
      await expect(capability.consume({ ...binding, ...mismatch })).rejects.toBeInstanceOf(
        ProtectedInputDeliveryError,
      );
      expect(resolve).not.toHaveBeenCalled();
    });
  }
});
