import { describe, expect, it } from "vitest";

import { BrowserSessionProvenance } from "../src/index.js";

describe("BrowserSessionProvenance", () => {
  it("allows safe lifecycle transitions", () => {
    const provenance = new BrowserSessionProvenance("context-safe", "safe");

    expect(provenance.canProduceEvidence()).toBe(true);

    provenance.transition("safe_parked");

    expect(provenance.canProduceEvidence()).toBe(false);

    provenance.transition("safe");

    expect(provenance.canProduceEvidence()).toBe(true);

    provenance.transition("destroyed");

    expect(provenance.value()).toBe("destroyed");
  });

  it("keeps protected contexts evidence-ineligible", () => {
    const provenance = new BrowserSessionProvenance("context-protected", "protected");

    expect(provenance.canProduceEvidence()).toBe(false);

    provenance.transition("tainted");

    expect(provenance.canProduceEvidence()).toBe(false);

    provenance.transition("destroyed");

    expect(provenance.value()).toBe("destroyed");
  });

  it("rejects invalid provenance transitions", () => {
    const provenance = new BrowserSessionProvenance("context-invalid", "protected");

    expect(() => provenance.transition("safe")).toThrow(
      "CONTEXT_PROVENANCE_TRANSITION_REJECTED:protected:safe",
    );
  });

  it("admits restored contexts only after verification", () => {
    const provenance = new BrowserSessionProvenance(
      "context-restored",
      "restored_pending_verification",
    );

    expect(provenance.canProduceEvidence()).toBe(false);

    provenance.transition("restored_safe");

    expect(provenance.canProduceEvidence()).toBe(true);
  });
});
