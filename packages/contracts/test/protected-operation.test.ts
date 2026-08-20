import { describe, expect, it } from "vitest";

import {
  assertProtectedOperationTransition,
  canTransitionProtectedOperation,
  protectedOperationDispatchMayBegin,
  protectedOperationLeaseExpiryState,
  protectedOperationStateSchema,
  protectedOperationTerminalStates,
} from "../src/protected-operation.js";

describe("protected operation state model", () => {
  it("admits the complete normal lifecycle", () => {
    const path = [
      "planned",
      "preparing",
      "ready_to_dispatch",
      "dispatching",
      "dispatched",
      "acquiring",
      "persisting",
      "persisted",
      "reconciling",
      "completed",
    ] as const;
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransitionProtectedOperation(path[index]!, path[index + 1]!)).toBe(true);
    }
  });

  it("makes ready-to-dispatch the sole dispatch authorization edge", () => {
    for (const state of protectedOperationStateSchema.options) {
      expect(protectedOperationDispatchMayBegin(state, "dispatching")).toBe(
        state === "ready_to_dispatch",
      );
    }
  });

  it("never permits post-dispatch states to return to a dispatchable state", () => {
    for (const state of [
      "dispatching",
      "dispatched",
      "acquiring",
      "persisting",
      "persisted",
      "reconciling",
      "recovery_required",
      "compromised",
    ] as const) {
      expect(canTransitionProtectedOperation(state, "ready_to_dispatch")).toBe(false);
      expect(canTransitionProtectedOperation(state, "dispatching")).toBe(false);
    }
  });

  it("classifies lease expiry before and after dispatch", () => {
    expect(protectedOperationLeaseExpiryState("preparing")).toBe("preparing");
    expect(protectedOperationLeaseExpiryState("ready_to_dispatch")).toBe("ready_to_dispatch");
    expect(protectedOperationLeaseExpiryState("dispatching")).toBe("recovery_required");
    expect(protectedOperationLeaseExpiryState("acquiring")).toBe("recovery_required");
    expect(protectedOperationLeaseExpiryState("completed")).toBe("completed");
    expect(protectedOperationLeaseExpiryState("dispatching", "read_only")).toBe(
      "failed_not_applied",
    );
    expect(protectedOperationLeaseExpiryState("acquiring", "read_only")).toBe("failed_not_applied");
  });

  it("fails closed for invalid and terminal transitions", () => {
    for (const state of protectedOperationTerminalStates) {
      for (const next of protectedOperationStateSchema.options) {
        expect(canTransitionProtectedOperation(state, next)).toBe(false);
      }
    }
    expect(() => assertProtectedOperationTransition("dispatched", "preparing")).toThrow(
      "PROTECTED_OPERATION_TRANSITION_INVALID:dispatched:preparing",
    );
  });
});
