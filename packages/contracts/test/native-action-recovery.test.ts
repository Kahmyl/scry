import { expect, it } from "vitest";
import {
  commandFeedback,
  releaseFeedback,
  canonicalFeedback,
  nativeActionIsUncertain,
  persistedNativeActionResult,
} from "../src/index.js";
function refused(prefix = 1): any {
  return {
    contractVersion: 2,
    planId: "test-refused-plan",
    complete: false,
    execution: prefix ? "partial" : "not_dispatched",
    businessOutcome: prefix ? "unverified" : "not_dispatched",
    reason: "guard_refused_before_dispatch",
    observation: "available",
    receipts: [
      ...Array.from({ length: prefix }, (_, index) => ({
        index,
        actionId: "completed-" + index,
        execution: "completed",
      })),
      {
        index: prefix,
        actionId: "refused-action",
        execution: "not_dispatched",
        businessOutcome: "not_dispatched",
        dispatch: {
          version: 1,
          state: "not_dispatched",
          source: "worker_guard",
          ownerGeneration: 1,
        },
      },
    ],
  };
}
it.each([
  { execution: "completed", receipts: [] },
  { execution: "tool_error", receipts: [] },
  { execution: "not_dispatched", businessOutcome: "not_dispatched", reason: "dispatch_started" },
  { execution: "not_dispatched", businessOutcome: "unverified" },
  { ...refused(), businessOutcome: "not_dispatched" },
])("keeps contradictory aggregate truth uncertain: %j", (r) => {
  expect(nativeActionIsUncertain(r)).toBe(true);
  expect(commandFeedback({ state: "completed", result: r }).state).toBe("unknown");
});
it.each([0, 1, 2, 7])(
  "preserves %i completed steps and offers fresh state without declaring full success",
  (prefix) => {
    const r = refused(prefix);
    expect(nativeActionIsUncertain(r)).toBe(false);
    expect(commandFeedback({ state: "completed", result: r })).toMatchObject({
      state: prefix ? "partial_sequence" : "not_dispatched",
      next: { action: "use_returned_observation" },
    });
    expect(r.complete).toBe(false);
  },
);
it.each([
  "version",
  "source",
  "generation",
  "index",
  "order",
  "unknown",
  "missing",
  "aggregate",
  "empty",
])("keeps a malformed %s refusal quarantined despite an attested known flag", (kind) => {
  const r = refused(2),
    last = r.receipts.at(-1);
  r.nativeActionFence = { version: 1, state: "known" };
  if (kind === "version") r.contractVersion = 1;
  if (kind === "source") last.dispatch.source = "agent_claim";
  if (kind === "generation") last.dispatch.ownerGeneration = 0;
  if (kind === "index") last.index = 0;
  if (kind === "order") r.receipts.reverse();
  if (kind === "unknown") r.receipts[0].execution = "unknown";
  if (kind === "missing") delete last.dispatch;
  if (kind === "aggregate") r.execution = "completed";
  if (kind === "empty") r.receipts = [];
  expect(nativeActionIsUncertain(r)).toBe(true);
  expect(persistedNativeActionResult(r).nativeActionFence).toEqual({
    version: 1,
    state: "uncertain",
  });
  expect(commandFeedback({ state: "completed", result: r }).state).toBe("unknown");
});
it.each([0, 1])(
  "active status with %i pending commands does not pretend release was requested",
  (pendingCommands) => {
    const r = releaseFeedback({
      state: "running",
      terminal: false,
      browserReleased: false,
      stopRequested: false,
      pendingCommands,
    });
    expect(r.state).toBe("active");
    expect(r.next.action).not.toBe("inspect_run_release");
    expect(canonicalFeedback(r)).toEqual(r);
  },
);
it("uncertainty takes precedence over healthy-active guidance and never permits a write", () => {
  const r = releaseFeedback({
    state: "running",
    terminal: false,
    browserReleased: false,
    stopRequested: false,
    pendingCommands: 0,
    recovery: { state: "uncertain_action" },
  });
  expect(r.state).toBe("unknown");
  expect(r.summary).toContain("do not repeat");
  expect(r.next.actor).toBe("operator");
});
it.each([
  { state: "running", terminal: false, stopRequested: true },
  { state: "failed", terminal: true, stopRequested: false },
])("keeps an existing closure ahead of uncertain-action inspection %j", (facts) => {
  const r = releaseFeedback({
    ...facts,
    browserReleased: false,
    recovery: { state: "uncertain_action" },
  });
  expect(r.state).toBe("release_pending");
  expect(r.next).toMatchObject({ tool: "get_run_status" });
  expect(r.summary).toContain("do not submit another stop");
  expect(canonicalFeedback(r)).toEqual(r);
});
it("round-trips all new finite refused-prefix guidance without admitting arbitrary copy", () => {
  for (const prefix of [0, 1])
    for (const observation of ["available", "unavailable"])
      for (const scopeRestrictionObserved of [false, true]) {
        const r = refused(prefix);
        Object.assign(r, { observation, scopeRestrictionObserved });
        const f = commandFeedback({ state: "completed", result: r });
        expect(canonicalFeedback(f)).toEqual(f);
        expect(canonicalFeedback({ ...f, summary: f.summary + " PRIVATE_VALUE" })).toBeUndefined();
      }
  for (const scopeRestrictionObserved of [false, true]) {
    const f = commandFeedback({
      state: "failed",
      result: {
        execution: "not_dispatched",
        businessOutcome: "not_dispatched",
        reason: "prior_uncertain_action",
        scopeRestrictionObserved,
      },
    });
    expect(canonicalFeedback(f)).toEqual(f);
  }
});
