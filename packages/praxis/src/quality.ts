import type { PraxisQualityFinding, PraxisRequest } from "@scry/contracts";
import type { PraxisGroundedTarget } from "./runtime.js";

export const PRAXIS_QUALITY_FINDING_CODES = [
  "MISSING_SEMANTIC_IDENTITY",
  "CONFLICTING_ACCESSIBLE_NAME",
  "KEYBOARD_PATH_UNAVAILABLE",
  "LABEL_CONTROL_ASSOCIATION_FAILURE",
  "AMBIGUOUS_DUPLICATE_IDENTITY",
  "TARGET_OBSTRUCTED",
  "UNSTABLE_CONTROL_IDENTITY",
  "VISUAL_ACCESSIBILITY_MISMATCH",
  "STATE_CHANGE_WITHOUT_FEEDBACK",
  "INVALID_ARIA_PATTERN",
  "SPECIALIZED_CUSTOM_CONTROL",
  "UNSAFE_TARGET_GEOMETRY",
  "CANVAS_ONLY_INTERACTION",
] as const;

export type MalformedControlFacts = {
  interactiveWithoutRole?: boolean;
  missingLabelAssociation?: boolean;
  incorrectLabelAssociation?: boolean;
  duplicateAccessibleName?: boolean;
  hiddenDuplicate?: boolean;
  customControl?: boolean;
  visualOnlyIdentity?: boolean;
  canvasOnly?: boolean;
};

export function classifyMalformedControlFacts(facts: MalformedControlFacts) {
  const codes: Array<(typeof PRAXIS_QUALITY_FINDING_CODES)[number]> = [];
  if (facts.interactiveWithoutRole || facts.visualOnlyIdentity)
    codes.push("MISSING_SEMANTIC_IDENTITY");
  if (facts.missingLabelAssociation || facts.incorrectLabelAssociation)
    codes.push("LABEL_CONTROL_ASSOCIATION_FAILURE");
  if (facts.duplicateAccessibleName) codes.push("AMBIGUOUS_DUPLICATE_IDENTITY");
  if (facts.hiddenDuplicate) codes.push("UNSTABLE_CONTROL_IDENTITY");
  if (facts.customControl) codes.push("SPECIALIZED_CUSTOM_CONTROL");
  if (facts.canvasOnly) codes.push("CANVAS_ONLY_INTERACTION");
  return codes;
}

export async function analyzePraxisQuality(
  target: PraxisGroundedTarget,
  request: PraxisRequest,
): Promise<PraxisQualityFinding[]> {
  const findings: PraxisQualityFinding[] = [];
  const families = new Set(target.resolution.evidenceFamilies);
  const semantics = await target.handle.use((locator) =>
    locator.evaluate((element) => {
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role");
      const ariaLabel = element.getAttribute("aria-label")?.trim() ?? "";
      const text = element.textContent?.trim() ?? "";
      const labels =
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
          ? (element.labels?.length ?? 0)
          : 0;
      const interactiveNative = ["button", "a", "input", "select", "textarea"].includes(tag);
      const clickable = element instanceof HTMLElement && typeof element.onclick === "function";
      const customRole = ["combobox", "listbox", "menu", "dialog"].includes(role ?? "");
      return { tag, role, ariaLabel, text, labels, interactiveNative, clickable, customRole };
    }),
  );
  if (!families.has("accessibility") && request.intent.preferredEvidence.roles.length)
    findings.push(
      finding(
        "MISSING_SEMANTIC_IDENTITY",
        "warning",
        0.82,
        "The control was resolved without computed accessibility identity.",
        "Expose the intended role and accessible name through native HTML or valid ARIA.",
      ),
    );
  for (const code of classifyMalformedControlFacts({
    interactiveWithoutRole: semantics.clickable && !semantics.interactiveNative && !semantics.role,
    missingLabelAssociation:
      ["input", "select", "textarea"].includes(semantics.tag) &&
      semantics.labels === 0 &&
      !semantics.ariaLabel,
    customControl: semantics.customRole && !semantics.interactiveNative,
  })) {
    if (findings.some((item) => item.code === code)) continue;
    findings.push(
      finding(
        code,
        "warning",
        0.95,
        "The resolved control has malformed or incomplete interaction semantics.",
        "Use native controls or implement complete accessible role, name, focus, and state semantics.",
      ),
    );
  }
  if (["focus_keyboard", "content_editable", "application_adapter"].includes(target.strategy))
    findings.push(
      finding(
        "SPECIALIZED_CUSTOM_CONTROL",
        "warning",
        0.78,
        "The control required specialized interaction behavior.",
        "Prefer a native control or implement the complete accessible keyboard and state pattern.",
      ),
    );
  if (target.strategy === "canvas_coordinate")
    findings.push(
      finding(
        "CANVAS_ONLY_INTERACTION",
        "error",
        0.95,
        "The interaction is available only through bounded canvas coordinates.",
        "Provide an equivalent semantic control and accessible state representation.",
      ),
    );
  if (request.operation.type === "activate" && request.expectedEffect.type === "none")
    findings.push(
      finding(
        "STATE_CHANGE_WITHOUT_FEEDBACK",
        "info",
        0.65,
        "The activation contract declares no observable application effect.",
        "Expose and author a deterministic effect that confirms the user-visible outcome.",
      ),
    );
  return findings;
}

function finding(
  code: (typeof PRAXIS_QUALITY_FINDING_CODES)[number],
  severity: "info" | "warning" | "error",
  confidence: number,
  summary: string,
  remediation: string,
): PraxisQualityFinding {
  return { code, severity, confidence, summary, remediation, evidence: {} };
}
