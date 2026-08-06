import type { InteractionTargetIntent } from "@scry/contracts";

export type InteractionRiskClass =
  | "read_only"
  | "ordinary"
  | "authentication"
  | "destructive"
  | "one_time_protected";

export type InteractionRiskPolicy = {
  riskClass: InteractionRiskClass;
  minimumConfidence: number;
  minimumConfidenceMargin: number;
  minimumIndependentEvidenceFamilies: number;
  allowsAgentCandidateChoice: boolean;
  allowsSelectorHint: boolean;
  requiresExplicitAuthorization: boolean;
};

const defaults: Record<InteractionRiskClass, InteractionRiskPolicy> = {
  read_only: {
    riskClass: "read_only",
    minimumConfidence: 0.5,
    minimumConfidenceMargin: 0.04,
    minimumIndependentEvidenceFamilies: 1,
    allowsAgentCandidateChoice: true,
    allowsSelectorHint: true,
    requiresExplicitAuthorization: false,
  },
  ordinary: {
    riskClass: "ordinary",
    minimumConfidence: 0.58,
    minimumConfidenceMargin: 0.08,
    minimumIndependentEvidenceFamilies: 2,
    allowsAgentCandidateChoice: true,
    allowsSelectorHint: true,
    requiresExplicitAuthorization: false,
  },
  authentication: {
    riskClass: "authentication",
    minimumConfidence: 0.76,
    minimumConfidenceMargin: 0.14,
    minimumIndependentEvidenceFamilies: 3,
    allowsAgentCandidateChoice: true,
    allowsSelectorHint: false,
    requiresExplicitAuthorization: false,
  },
  destructive: {
    riskClass: "destructive",
    minimumConfidence: 0.84,
    minimumConfidenceMargin: 0.18,
    minimumIndependentEvidenceFamilies: 3,
    allowsAgentCandidateChoice: false,
    allowsSelectorHint: false,
    requiresExplicitAuthorization: true,
  },
  one_time_protected: {
    riskClass: "one_time_protected",
    minimumConfidence: 0.86,
    minimumConfidenceMargin: 0.2,
    minimumIndependentEvidenceFamilies: 3,
    allowsAgentCandidateChoice: false,
    allowsSelectorHint: false,
    requiresExplicitAuthorization: true,
  },
};

export function interactionRiskClass(
  risk: InteractionTargetIntent["risk"],
): InteractionRiskClass {
  if (risk === "read_only") return "read_only";
  if (risk === "ordinary") return "ordinary";
  if (risk === "authentication" || risk === "credential") return "authentication";
  if (risk === "destructive" || risk === "live") return "destructive";
  return "one_time_protected";
}

export function interactionRiskPolicy(
  intent: InteractionTargetIntent,
): InteractionRiskPolicy {
  const base = defaults[interactionRiskClass(intent.risk)];

  return {
    ...base,
    minimumConfidence:
      intent.confidence.minimum ?? base.minimumConfidence,
    minimumConfidenceMargin:
      intent.confidence.minimumMargin ?? base.minimumConfidenceMargin,
    minimumIndependentEvidenceFamilies:
      intent.confidence.minimumFamilyCount ??
      base.minimumIndependentEvidenceFamilies,
  };
}
