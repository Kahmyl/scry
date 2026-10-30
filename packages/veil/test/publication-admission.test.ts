import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BrowserProtectionDecision } from "@scry/contracts";
import { assertPublicationDecisionSet, assertPublicationDisclosure } from "../src/index.js";

function publication() {
  const decision: BrowserProtectionDecision = {
    captureId: "capture",
    effectId: "effect",
    key: "resourceId",
    path: ["id"],
    label: "public",
    allowedSinks: ["database_safe_field"],
    valueDigest: createHash("sha256").update("resource-123").digest("hex"),
    decisionRevision: 1,
    decisionDigest: "a".repeat(64),
    reason: "trusted output",
    publicAdmissionMode: "trusted_application_output",
    publicSemantic: "resourceId",
    publicEvidenceDigest: "b".repeat(64),
    publicProposalDigest: "c".repeat(64),
  };
  return {
    captureId: "capture",
    effectId: "effect",
    publicOutputs: { resourceId: "resource-123" },
    protectedOutputs: {} as Record<string, string>,
    decisions: [decision],
  };
}

describe("publication admission at the persistence boundary", () => {
  it("accepts only a complete, scoped decision set for all outputs", () => {
    const input = publication();
    expect(assertPublicationDecisionSet(input)).toBe(1);
    expect(() => assertPublicationDecisionSet({ ...input, decisions: [] })).toThrow(
      "SCRY_BROWSER_PROTECTION_DECISION_SET_INCOMPLETE",
    );
    expect(() =>
      assertPublicationDecisionSet({ ...input, protectedOutputs: { resourceId: "secret" } }),
    ).toThrow("SCRY_BROWSER_OUTPUT_NAME_DUPLICATE");
    expect(() => assertPublicationDecisionSet({ ...input, effectId: "other-effect" })).toThrow(
      "SCRY_BROWSER_PROTECTION_DECISION_SET_INVALID",
    );
  });

  it("requires matching captured paths, values, sinks, and trusted disclosure", () => {
    const input = publication();
    const paths = [{ path: ["id"] }];
    expect(() =>
      assertPublicationDisclosure(input, paths, "trusted_application_output"),
    ).not.toThrow();
    expect(() => assertPublicationDisclosure(input, [], "trusted_application_output")).toThrow(
      "SCRY_BROWSER_PROTECTION_DECISION_PATH_INVALID",
    );
    expect(() =>
      assertPublicationDisclosure(
        { ...input, publicOutputs: { resourceId: "changed" } },
        paths,
        "trusted_application_output",
      ),
    ).toThrow("SCRY_BROWSER_PROTECTION_DECISION_VALUE_INVALID");
    expect(() => assertPublicationDisclosure(input, paths, "confidential")).toThrow(
      "SCRY_BROWSER_PUBLIC_ADMISSION_INVALID",
    );
    input.decisions[0]!.allowedSinks = ["report"];
    expect(() => assertPublicationDisclosure(input, paths, "trusted_application_output")).toThrow(
      "SCRY_BROWSER_PROTECTION_DECISION_VALUE_INVALID",
    );
  });
});
