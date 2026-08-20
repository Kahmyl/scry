import { readFile } from "node:fs/promises";
import type { ControlCapabilities } from "@scry/contracts";
import { describe, expect, it } from "vitest";
import {
  aggregateRejectedCapabilitySignatures,
  GroundingError,
  rejectedCapabilitySignature,
  type GroundingDiagnostic,
} from "../src/grounding.js";

const capabilities = (overrides: Partial<ControlCapabilities> = {}): ControlCapabilities => ({
  canFocus: true,
  canReceivePointer: true,
  canActivateWithKeyboard: false,
  canAcceptText: true,
  canToggle: false,
  canSelectOption: false,
  canSubmit: false,
  canReadValue: true,
  visible: true,
  enabled: true,
  editable: true,
  readonly: false,
  nativeKind: "input",
  computedRole: "textbox",
  ...overrides,
});

const diagnostic = (
  signatures: GroundingDiagnostic["rejectedCapabilitySignatures"],
): GroundingDiagnostic => ({
  candidateCount: signatures.reduce((total, item) => total + item.count, 0),
  eligibleCount: 0,
  confidence: 0,
  confidenceMargin: 0,
  scope: { kind: "page" },
  rejectedConstraints: ["accepts_text"],
  rejectedCapabilitySignatures: signatures,
  drift: "unchanged",
  safeActions: ["revise_intent", "narrow_scope"],
  resolutionSource: "unified",
  visualCandidateCount: 0,
  observation: { status: "succeeded" },
});

describe("privacy-safe rejected capability diagnostics", () => {
  it("aggregates identical observations and preserves the rejected count", () => {
    const result = aggregateRejectedCapabilitySignatures([capabilities(), capabilities()]);
    expect(result).toEqual([
      {
        count: 2,
        nativeKindClass: "input",
        computedRoleClass: "textbox",
        visible: "yes",
        enabled: "yes",
        readonly: "no",
        acceptsText: "yes",
        focusable: "yes",
        editable: "yes",
      },
    ]);
    expect(result.reduce((total, item) => total + item.count, 0)).toBe(2);
  });

  it("is invariant to observation order", () => {
    const input = capabilities();
    const textarea = capabilities({
      nativeKind: "textarea",
      enabled: false,
      readonly: true,
      editable: false,
    });
    expect(aggregateRejectedCapabilitySignatures([input, textarea])).toEqual(
      aggregateRejectedCapabilitySignatures([textarea, input]),
    );
  });

  it("categorizes input, textarea, and non-native ARIA textbox without inventing contenteditable", () => {
    expect(rejectedCapabilitySignature(capabilities())).toMatchObject({
      nativeKindClass: "input",
      computedRoleClass: "textbox",
    });
    expect(rejectedCapabilitySignature(capabilities({ nativeKind: "textarea" }))).toMatchObject({
      nativeKindClass: "textarea",
      computedRoleClass: "textbox",
    });
    const aria = rejectedCapabilitySignature(
      capabilities({
        nativeKind: "div",
        computedRole: "textbox",
        canAcceptText: false,
        editable: false,
      }),
    );
    expect(aria).toMatchObject({
      nativeKindClass: "other",
      computedRoleClass: "textbox",
      acceptsText: "no",
      editable: "no",
    });
    expect(JSON.stringify(aria)).not.toContain("contenteditable");
  });

  it("represents visibility, enabled, readonly, text, focus, and edit capabilities categorically", () => {
    expect(
      rejectedCapabilitySignature(
        capabilities({
          visible: false,
          enabled: false,
          readonly: true,
          canAcceptText: false,
          canFocus: false,
          editable: false,
        }),
      ),
    ).toMatchObject({
      visible: "no",
      enabled: "no",
      readonly: "yes",
      acceptsText: "no",
      focusable: "no",
      editable: "no",
    });
  });

  it("collapses arbitrary native kinds and roles to allowlisted other classes", () => {
    expect(
      rejectedCapabilitySignature(
        capabilities({ nativeKind: "provider-canary-kind", computedRole: "provider-canary-role" }),
      ),
    ).toMatchObject({ nativeKindClass: "other", computedRoleClass: "other" });
  });

  it("cannot serialize raw observation identity or geometry", () => {
    const canary = "PRIVATE-CAPABILITY-CANARY";
    const unsafeInput = {
      ...capabilities({ nativeKind: canary, computedRole: canary }),
      accessibleName: canary,
      placeholder: canary,
      name: canary,
      label: canary,
      value: canary,
      text: canary,
      runtimeId: canary,
      path: [canary],
      fingerprint: canary,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      index: 7,
    } as ControlCapabilities;
    const serialized = JSON.stringify(aggregateRejectedCapabilitySignatures([unsafeInput]));
    expect(serialized).not.toContain(canary);
    const keys = Object.keys(JSON.parse(serialized)[0] as Record<string, unknown>);
    expect(keys).not.toEqual(
      expect.arrayContaining([
        "accessibleName",
        "label",
        "placeholder",
        "value",
        "text",
        "runtimeId",
        "path",
        "selector",
        "xpath",
        "fingerprint",
        "bounds",
        "index",
      ]),
    );
  });

  it("preserves NO_CAPABILITY_COMPATIBLE_CONTROL error and candidate/count semantics", () => {
    const signatures = aggregateRejectedCapabilitySignatures([
      capabilities(),
      capabilities({ visible: false }),
    ]);
    const error = new GroundingError(
      "NO_CAPABILITY_COMPATIBLE_CONTROL",
      diagnostic(signatures),
      "safe-digest",
    );
    expect(error.code).toBe("NO_CAPABILITY_COMPATIBLE_CONTROL");
    expect(error.candidates).toEqual([]);
    expect(error.diagnostic.candidateCount).toBe(2);
    expect(error.diagnostic.eligibleCount).toBe(0);
    expect(
      error.diagnostic.rejectedCapabilitySignatures.reduce((total, item) => total + item.count, 0),
    ).toBe(2);
  });

  it("records the aggregate before discard without changing ranking or rejection calls", async () => {
    const source = await readFile(new URL("../src/grounding.ts", import.meta.url), "utf8");
    expect(source).toMatch(
      /if \(violations\.length\)[\s\S]*recordRejectedCapabilitySignature\(rejectedCapabilitySignatures, meta\.capabilities\);[\s\S]*continue;/,
    );
    expect(source).toMatch(
      /NO_CAPABILITY_COMPATIBLE_CONTROL[\s\S]*safeActions: \["revise_intent", "narrow_scope"\]/,
    );
    expect(source).not.toMatch(
      /NO_CAPABILITY_COMPATIBLE_CONTROL[\s\S]{0,300}reject\([^)]*, candidates\)/,
    );
    expect(source).toContain(
      "const ranked = collapseEquivalentActions(intent, semanticCompetition);",
    );
  });

  it("characterizes the three-tier textbox inventory without browser execution", async () => {
    const source = await readFile(new URL("../src/grounding.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "textbox:\n    \"textarea,input:not([type]),input[type=text],input[type=email],input[type=password],input[type=search],input[type=tel],input[type=url],[role=textbox],[contenteditable='true']\"",
    );
    expect(source).toMatch(
      /const primary = roleSelectors\.length[\s\S]*?: capabilitySelector\(intent\);/,
    );
    expect(source).toMatch(
      /if \(primaryCount > 0\) return \{ locator: primaryLocator, count: primaryCount \};/,
    );
    expect(source).toMatch(
      /const fallbackSelector = capabilitySelector\(intent\);[\s\S]*if \(fallbackCount > 0\) return/,
    );
    expect(source).toMatch(
      /const diagnostic = scope\.locator\(`\$\{INTERACTIVE_INVENTORY\},\$\{READABLE_INVENTORY\}`\);/,
    );
    expect(source).not.toMatch(
      /planCandidateInventory[\s\S]{0,1200}preferredEvidence\.placeholders/,
    );
    expect(source).not.toMatch(
      /planCandidateInventory[\s\S]{0,1200}preferredEvidence\.expectedText/,
    );
  });
});
