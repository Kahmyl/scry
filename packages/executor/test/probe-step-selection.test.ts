import type { CurrentPlan } from "@scry/contracts";
import { describe, expect, it } from "vitest";

import { reversibleProbePartition } from "../src/probe.js";

describe("reversible probe step selection", () => {
  it("preserves execution order by stopping at the first non-reversible step", () => {
    const steps = [
      { id: "open", action: { type: "navigate" } },
      { id: "fill", action: { type: "fill" } },
      {
        id: "authenticate",
        action: {
          type: "click",
          target: { risk: "ordinary" },
          expectedEffect: { type: "navigation" },
        },
      },
      {
        id: "toggle-test-mode",
        action: { type: "click", target: { risk: "ordinary" }, expectedEffect: { type: "none" } },
      },
    ] as unknown as CurrentPlan["steps"];

    const partition = reversibleProbePartition(steps);

    expect(partition.steps.map((step) => step.id)).toEqual(["open", "fill"]);
    expect(partition.omitted.map((step) => step.id)).toEqual(["authenticate", "toggle-test-mode"]);
  });
});
