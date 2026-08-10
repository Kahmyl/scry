import { describe, expect, it } from "vitest";

import { agentDecisionBoundarySchema, executionCapabilityNameSchema, operationOutcomeSchema } from "../src/execution-kernel.js";

describe("execution kernel contracts", () => {
  it("models protected input independently from protected operations", () => {
    expect(executionCapabilityNameSchema.parse("protected_input")).toBe("protected_input");
    expect(() => executionCapabilityNameSchema.parse("protected_input_unknown")).toThrow();
  });

  it("admits the applied-but-unverified observation boundary", () => {
    const boundary = {
      type: "effect_observation_required" as const,
      reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED",
      safeActions: ["get_flow_authoring", "advance_flow_authoring"],
    };
    expect(agentDecisionBoundarySchema.parse(boundary)).toEqual(boundary);
    expect(operationOutcomeSchema.parse({
      operationId: "applied-effect",
      functionalResult: "failed",
      mutationOutcome: "applied",
      privacyResult: "unverified",
      evidenceResult: [],
      qualityFindings: [],
      durationMs: 1,
      reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED",
      nextDecisionBoundary: boundary,
    })).toMatchObject({ mutationOutcome: "applied", nextDecisionBoundary: boundary });
  });
});
