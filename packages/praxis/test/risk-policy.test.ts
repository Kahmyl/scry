import type { InteractionTargetIntent } from "@scry/contracts";
import { describe, expect, it } from "vitest";

import {
  interactionRiskClass,
  interactionRiskPolicy,
} from "../src/risk-policy.js";

function intent(
  risk: InteractionTargetIntent["risk"],
  confidence: InteractionTargetIntent["confidence"] = {
    requiredFamilies: [],
  },
): InteractionTargetIntent {
  return {
    concept: "continue",
    requiredCapabilities: ["pointer_activatable"],
    preferredEvidence: {
      roles: ["button"],
      names: ["Continue"],
      labels: [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk,
    confidence,
  };
}

describe("risk adaptive grounding policy", () => {
  it("uses relaxed thresholds for read-only interactions", () => {
    expect(interactionRiskPolicy(intent("read_only"))).toMatchObject({
      riskClass: "read_only",
      minimumConfidence: 0.5,
      minimumConfidenceMargin: 0.04,
      minimumIndependentEvidenceFamilies: 1,
      allowsAgentCandidateChoice: true,
      allowsSelectorHint: true,
      requiresExplicitAuthorization: false,
    });
  });

  it("requires stronger evidence for authentication interactions", () => {
    expect(interactionRiskPolicy(intent("authentication"))).toMatchObject({
      riskClass: "authentication",
      minimumConfidence: 0.76,
      minimumConfidenceMargin: 0.14,
      minimumIndependentEvidenceFamilies: 3,
      allowsAgentCandidateChoice: true,
      allowsSelectorHint: false,
    });

    expect(interactionRiskClass("credential")).toBe("authentication");
  });

  it("requires strongest evidence for destructive and protected interactions", () => {
    expect(interactionRiskPolicy(intent("destructive"))).toMatchObject({
      riskClass: "destructive",
      minimumConfidence: 0.84,
      minimumConfidenceMargin: 0.18,
      minimumIndependentEvidenceFamilies: 3,
      allowsAgentCandidateChoice: false,
      requiresExplicitAuthorization: true,
    });

    expect(interactionRiskPolicy(intent("protected"))).toMatchObject({
      riskClass: "one_time_protected",
      minimumConfidence: 0.86,
      minimumConfidenceMargin: 0.2,
      minimumIndependentEvidenceFamilies: 3,
      allowsAgentCandidateChoice: false,
      requiresExplicitAuthorization: true,
    });
  });

  it("honors explicit confidence overrides without weakening other policy flags", () => {
    expect(
      interactionRiskPolicy(
        intent("destructive", {
          requiredFamilies: ["accessibility"],
          minimum: 0.91,
          minimumMargin: 0.25,
          minimumFamilyCount: 4,
        }),
      ),
    ).toMatchObject({
      riskClass: "destructive",
      minimumConfidence: 0.91,
      minimumConfidenceMargin: 0.25,
      minimumIndependentEvidenceFamilies: 4,
      allowsAgentCandidateChoice: false,
      allowsSelectorHint: false,
      requiresExplicitAuthorization: true,
    });
  });
});
