import { createHash } from "node:crypto";
import type { BrowserProtectionDecision } from "@scry/contracts";

interface PublicationInput {
  effectId: string;
  captureId: string;
  publicOutputs: Record<string, string | number | boolean | null>;
  protectedOutputs: Record<string, string>;
  decisions: readonly BrowserProtectionDecision[];
}

export function assertPublicationDecisionSet(input: PublicationInput): number {
  const outputEntries = [
    ...Object.entries(input.publicOutputs),
    ...Object.entries(input.protectedOutputs),
  ];
  if (outputEntries.length === 0) throw new Error("SCRY_BROWSER_OUTPUTS_REQUIRED");
  if (new Set(outputEntries.map(([name]) => name)).size !== outputEntries.length)
    throw new Error("SCRY_BROWSER_OUTPUT_NAME_DUPLICATE");
  if (input.decisions.length !== outputEntries.length)
    throw new Error("SCRY_BROWSER_PROTECTION_DECISION_SET_INCOMPLETE");
  const decisionNames = new Set(input.decisions.map((decision) => decision.key));
  if (
    decisionNames.size !== input.decisions.length ||
    outputEntries.some(([name]) => !decisionNames.has(name)) ||
    input.decisions.some(
      (decision) => decision.captureId !== input.captureId || decision.effectId !== input.effectId,
    )
  )
    throw new Error("SCRY_BROWSER_PROTECTION_DECISION_SET_INVALID");
  return outputEntries.length;
}

export function assertPublicationDisclosure(
  input: PublicationInput,
  structuralIndex: readonly { path: unknown }[],
  disclosureMode: string | undefined,
): void {
  const capturedPaths = new Set(structuralIndex.map((node) => JSON.stringify(node.path)));
  for (const decision of input.decisions) {
    if (!capturedPaths.has(JSON.stringify(decision.path)))
      throw new Error("SCRY_BROWSER_PROTECTION_DECISION_PATH_INVALID");
    const publicValue = input.publicOutputs[decision.key];
    const protectedValue = input.protectedOutputs[decision.key];
    if (
      (decision.label === "public" &&
        (publicValue === undefined ||
          protectedValue !== undefined ||
          !decision.allowedSinks.includes("database_safe_field") ||
          digestOutputValue(publicValue) !== decision.valueDigest)) ||
      (decision.label === "protected" &&
        (protectedValue === undefined ||
          publicValue !== undefined ||
          digestOutputValue(protectedValue) !== decision.valueDigest))
    )
      throw new Error("SCRY_BROWSER_PROTECTION_DECISION_VALUE_INVALID");
    if (decision.label === "public") {
      if (
        disclosureMode !== "trusted_application_output" ||
        decision.publicAdmissionMode !== "trusted_application_output" ||
        !decision.publicSemantic ||
        !decision.publicEvidenceDigest ||
        !decision.publicProposalDigest
      )
        throw new Error("SCRY_BROWSER_PUBLIC_ADMISSION_INVALID");
    }
  }
}

function digestOutputValue(value: string | number | boolean | null): string {
  return createHash("sha256")
    .update(value === null ? "null" : String(value))
    .digest("hex");
}
