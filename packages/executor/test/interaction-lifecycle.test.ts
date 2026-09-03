import { describe, expect, it, vi } from "vitest";

import { InteractionLifecycleTracker } from "../src/interaction-lifecycle.js";

describe("interaction lifecycle authority", () => {
  it.each([
    ["target absent", "not_applied"],
    ["target ambiguous", "not_applied"],
    ["section ambiguous", "not_applied"],
    ["capability incompatible", "not_applied"],
    ["policy refused", "unknown"],
    ["resolver introduced a future code", "unknown"],
  ] as const)(
    "settles pre-dispatch mutation failure as not-applied regardless of diagnostic: %s",
    (_diagnostic, observed) => {
      const lifecycle = new InteractionLifecycleTracker();
      expect(lifecycle.mutationFailure(true, observed)).toBe("not_applied");
    },
  );

  it("preserves uncertainty only after the dispatch transition", async () => {
    const lifecycle = new InteractionLifecycleTracker();
    const durableFence = vi.fn(async () => undefined);
    await lifecycle.beforeDispatch(durableFence);
    expect(lifecycle.mutationFailure(true, "not_applied")).toBe("unknown");
    expect(durableFence).toHaveBeenCalledOnce();
  });

  it("records dispatch idempotently under duplicate adapter callbacks", async () => {
    const durableFence = vi.fn(async () => undefined);
    const lifecycle = new InteractionLifecycleTracker();
    await Promise.all([
      lifecycle.beforeDispatch(durableFence),
      lifecycle.beforeDispatch(durableFence),
    ]);
    expect(durableFence).toHaveBeenCalledOnce();
  });

  it("never promotes an observation failure into a mutation", async () => {
    const lifecycle = new InteractionLifecycleTracker();
    await lifecycle.beforeDispatch();
    expect(lifecycle.mutationFailure(false, "unknown")).toBe("not_applied");
  });

  it("derives protected failure privacy from the sealed phase", () => {
    const lifecycle = new InteractionLifecycleTracker();
    lifecycle.recordPrivacy("entered");
    lifecycle.recordPrivacy("sealed");
    expect(lifecycle.privacyFailure("unverified")).toBe("sealed");
  });

  it("does not claim privacy sealing when sealing never completed", () => {
    const lifecycle = new InteractionLifecycleTracker();
    lifecycle.recordPrivacy("entered");
    expect(lifecycle.privacyFailure("unverified")).toBe("unverified");
  });
});
