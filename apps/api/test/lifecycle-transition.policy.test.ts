import { describe, expect, it } from "vitest";

import { decideLifecycleTransition } from "../src/lifecycle/lifecycle-transition.policy.js";

describe("lifecycle transition authority", () => {
  it("requires successor continuity for an ordinary passed Run", () => {
    expect(
      decideLifecycleTransition({
        kind: "complete_run",
        state: "passed",
        outcomeClassification: "passed",
        terminalProtectedBoundary: { kind: "not_requested" },
      }),
    ).toEqual({
      accepted: true,
      successorCheckpoint: {
        kind: "required",
      },
    });
  });

  it("does not manufacture successor continuity for an unsuccessful Run", () => {
    expect(
      decideLifecycleTransition({
        kind: "complete_run",
        state: "failed",
        outcomeClassification: "inconclusive_plan",
        terminalProtectedBoundary: { kind: "not_requested" },
      }),
    ).toEqual({
      accepted: true,
      successorCheckpoint: {
        kind: "forbidden",
        reason: "run_not_successful",
      },
    });
  });

  it("does not require successor continuity when a passed state is not classified as passed", () => {
    expect(
      decideLifecycleTransition({
        kind: "complete_run",
        state: "passed",
        outcomeClassification: "assertion_failure",
        terminalProtectedBoundary: { kind: "not_requested" },
      }),
    ).toEqual({
      accepted: true,
      successorCheckpoint: {
        kind: "forbidden",
        reason: "run_not_successful",
      },
    });
  });

  it("admits proven terminal protected completion without a browser checkpoint", () => {
    expect(
      decideLifecycleTransition({
        kind: "complete_run",
        state: "passed",
        outcomeClassification: "passed",
        terminalProtectedBoundary: {
          kind: "proven",
          praxisSessionId: "11111111-1111-4111-8111-111111111111",
          protectedOperationId: "22222222-2222-4222-8222-222222222222",
        },
      }),
    ).toEqual({
      accepted: true,
      successorCheckpoint: {
        kind: "forbidden",
        reason: "terminal_protected_operation",
        praxisSessionId: "11111111-1111-4111-8111-111111111111",
        protectedOperationId: "22222222-2222-4222-8222-222222222222",
      },
    });
  });

  it("fails closed when terminal protected completion is requested but unproven", () => {
    expect(
      decideLifecycleTransition({
        kind: "complete_run",
        state: "passed",
        outcomeClassification: "passed",
        terminalProtectedBoundary: { kind: "unproven" },
      }),
    ).toEqual({
      accepted: false,
      code: "RUN_TERMINAL_PROTECTED_COMPLETION_UNPROVEN",
    });
  });

  it("rejects terminal protected completion for a non-passed Run", () => {
    expect(
      decideLifecycleTransition({
        kind: "complete_run",
        state: "failed",
        outcomeClassification: "inconclusive_plan",
        terminalProtectedBoundary: {
          kind: "proven",
          praxisSessionId: "11111111-1111-4111-8111-111111111111",
          protectedOperationId: "22222222-2222-4222-8222-222222222222",
        },
      }),
    ).toEqual({
      accepted: false,
      code: "RUN_TERMINAL_PROTECTED_COMPLETION_INVALID",
    });
  });
});
