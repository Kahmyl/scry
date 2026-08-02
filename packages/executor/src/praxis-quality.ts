import type { PraxisQualityFinding, PraxisRequest } from "@scry/contracts";
import type { PraxisGroundedTarget } from "./praxis-runtime.js";

export const PRAXIS_QUALITY_FINDING_CODES = [
  "MISSING_SEMANTIC_IDENTITY", "CONFLICTING_ACCESSIBLE_NAME", "KEYBOARD_PATH_UNAVAILABLE",
  "LABEL_CONTROL_ASSOCIATION_FAILURE", "AMBIGUOUS_DUPLICATE_IDENTITY", "TARGET_OBSTRUCTED",
  "UNSTABLE_CONTROL_IDENTITY", "VISUAL_ACCESSIBILITY_MISMATCH", "STATE_CHANGE_WITHOUT_FEEDBACK",
  "INVALID_ARIA_PATTERN", "SPECIALIZED_CUSTOM_CONTROL", "UNSAFE_TARGET_GEOMETRY", "CANVAS_ONLY_INTERACTION",
] as const;

export function analyzePraxisQuality(target: PraxisGroundedTarget, request: PraxisRequest): PraxisQualityFinding[] {
  const findings: PraxisQualityFinding[] = [];
  const families = new Set(target.resolution.evidenceFamilies);
  if (!families.has("accessibility") && request.intent.preferredEvidence.roles.length) findings.push(finding("MISSING_SEMANTIC_IDENTITY", "warning", .82, "The control was resolved without computed accessibility identity.", "Expose the intended role and accessible name through native HTML or valid ARIA."));
  if (["focus_keyboard","content_editable","application_adapter"].includes(target.strategy)) findings.push(finding("SPECIALIZED_CUSTOM_CONTROL", "warning", .78, "The control required specialized interaction behavior.", "Prefer a native control or implement the complete accessible keyboard and state pattern."));
  if (target.strategy === "canvas_coordinate") findings.push(finding("CANVAS_ONLY_INTERACTION", "error", .95, "The interaction is available only through bounded canvas coordinates.", "Provide an equivalent semantic control and accessible state representation."));
  if (request.operation.type === "activate" && request.expectedEffect.type === "none") findings.push(finding("STATE_CHANGE_WITHOUT_FEEDBACK", "info", .65, "The activation contract declares no observable application effect.", "Expose and author a deterministic effect that confirms the user-visible outcome."));
  return findings;
}

function finding(code: typeof PRAXIS_QUALITY_FINDING_CODES[number], severity: "info"|"warning"|"error", confidence: number, summary: string, remediation: string): PraxisQualityFinding { return { code, severity, confidence, summary, remediation, evidence: {} }; }
