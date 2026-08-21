import { describe, expect, it } from "vitest";

import { FlowService } from "../src/flows/flow.service.js";

describe("agent-first public capabilities", () => {
  it("advertises factual live-session execution without retired admission authority", () => {
    const capabilities = new FlowService({} as never, {} as never).capabilities();
    expect(capabilities.agentDirectedExecution).toEqual({
      livePraxisSession: true,
      factualObservation: true,
      exactReferenceRequired: true,
      durableRunLedger: true,
      explicitRunFinalization: true,
      automaticProgression: false,
      compileCertificationRequired: false,
      calibrationRequired: false,
    });
    expect(capabilities.adaptiveExecution).toMatchObject({ authoringTurn: false });
    expect(capabilities.adaptiveExecution.modes).not.toContain("certify");
    expect(capabilities.groundingCapabilities).not.toContain("risk-thresholds");
    expect(capabilities.groundingCapabilities).not.toContain("effect-verification");
  });
});
