import { describe, expect, it } from "vitest";
import { AdaptiveSessionKernelRunner } from "../src/adaptive-sessions/adaptive-session-kernel.runner.js";

function runnerAt(url: string) {
  const runner = Object.create(AdaptiveSessionKernelRunner.prototype) as any;
  runner.runtimes = new Map([["session", { session: { page: { url: () => url }, documentEpoch: () => 1 }, fencingToken: 1, tail: Promise.resolve() }]]);
  runner.exclusive = async (_runtime: unknown, work: () => unknown) => work();
  runner.__dispatchCount = 0;
  return runner as AdaptiveSessionKernelRunner;
}

describe("adaptive UNKNOWN reconciliation baseline", () => {
  it("proves navigation only when the authoritative destination was not already satisfied", async () => {
    const runner = runnerAt("https://example.test/destination");
    const effect = { type: "navigation" as const, url: "https://example.test/destination", match: "exact" as const };
    await expect(runner.reconcileUnknownEffect("session", effect, {
      url: "https://example.test/source",documentEpoch: 1,effectState: { navigationUrl: "https://example.test/source" },
    })).resolves.toMatchObject({ result: "proven_applied" });
    expect((runner as any).__dispatchCount).toBe(0);
    await expect(runner.reconcileUnknownEffect("session", effect, {
      url: "https://example.test/destination",documentEpoch: 1,effectState: { navigationUrl: "https://example.test/destination" },
    })).resolves.toMatchObject({ result: "still_unknown", reasonCode: "RECONCILIATION_EFFECT_ALREADY_SATISFIED_BEFORE_DISPATCH" });
  });

  it("does not infer not-applied from an inverse current state or operate without a baseline", async () => {
    const runner = runnerAt("https://example.test/source");
    const effect = { type: "navigation" as const, url: "https://example.test/destination", match: "exact" as const };
    await expect(runner.reconcileUnknownEffect("session", effect, {
      url: "https://example.test/source",documentEpoch: 1,effectState: { navigationUrl: "https://example.test/source" },
    })).resolves.toMatchObject({ result: "still_unknown" });
    await expect(runner.reconcileUnknownEffect("session", effect, null)).resolves.toMatchObject({
      result: "still_unknown",reasonCode: "RECONCILIATION_PRE_DISPATCH_BASELINE_UNAVAILABLE",
    });
  });

  it("requires an explicit inverse same-document visibility baseline", async () => {
    const runner = runnerAt("https://example.test/source");
    const target = { concept: "panel", requiredCapabilities: ["inspect" as const],
      preferredEvidence: { roles: ["region" as const], names: ["Panel"] } } as any;
    await expect(runner.reconcileUnknownEffect("session", {
      type: "visibility_change", target, visible: false,
    }, { url: "https://example.test/source", documentEpoch: 1,
      effectState: { visibility: "unresolved" } })).resolves.toMatchObject({
      result: "still_unknown", reasonCode: "RECONCILIATION_PRE_DISPATCH_VISIBILITY_UNRESOLVED",
    });
    await expect(runner.reconcileUnknownEffect("session", {
      type: "visibility_change", target, visible: true,
    }, { url: "https://example.test/source", documentEpoch: 2,
      effectState: { visibility: "hidden_or_absent" } })).resolves.toMatchObject({
      result: "still_unknown", reasonCode: "RECONCILIATION_VISIBILITY_DOCUMENT_CHANGED",
    });
    expect((runner as any).__dispatchCount).toBe(0);
  });

  it("does not semantically re-resolve visibility without an exact authoritative reference", async () => {
    const runner = runnerAt("https://example.test/source");
    const target = { concept: "panel", requiredCapabilities: ["inspect" as const],
      preferredEvidence: { roles: ["region" as const], names: ["Panel"] } } as any;
    await expect(runner.reconcileUnknownEffect("session", {
      type: "visibility_change", target, visible: false,
    }, { url: "https://example.test/source", documentEpoch: 1,
      effectState: { visibility: "visible" } })).resolves.toMatchObject({
      result: "still_unknown",
      reasonCode: "RECONCILIATION_AUTHORITATIVE_REFERENCE_REQUIRED",
    });
    expect((runner as any).__dispatchCount).toBe(0);
  });
});
