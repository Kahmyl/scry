import { describe, expect, it } from "vitest";

import { classifyProbeCompilationInput } from "../src/authoring/authoring.service.js";

describe("Probe compilation diagnostic classification", () => {
  it("keeps quality findings non-blocking", () => {
    const finding = {
      code: "FIELD_HAS_NO_ASSOCIATED_LABEL",
      message: "Field has no associated label.",
    };

    expect(
      classifyProbeCompilationInput({
        diagnostics: [finding],
      }),
    ).toEqual({
      blockers: [],
      warnings: [],
      qualityFindings: [finding],
    });
  });

  it("keeps structural grounding failures blocking", () => {
    const blocker = {
      code: "TARGET_AMBIGUOUS",
      message: "Multiple compatible targets remain.",
    };

    expect(
      classifyProbeCompilationInput({
        diagnostics: [blocker],
      }),
    ).toEqual({
      blockers: [blocker],
      warnings: [],
      qualityFindings: [],
    });
  });

  it("maps unknown legacy diagnostics to warnings", () => {
    const warning = {
      code: "LEGACY_NON_FATAL_DIAGNOSTIC",
      message: "Legacy warning.",
    };

    expect(
      classifyProbeCompilationInput({
        diagnostics: [warning],
      }),
    ).toEqual({
      blockers: [],
      warnings: [warning],
      qualityFindings: [],
    });
  });

  it("preserves explicitly separated Probe output", () => {
    const blocker = { code: "EXPLICIT_BLOCKER" };
    const warning = { code: "EXPLICIT_WARNING" };
    const finding = { code: "EXPLICIT_QUALITY_FINDING" };

    expect(
      classifyProbeCompilationInput({
        blockers: [blocker],
        warnings: [warning],
        qualityFindings: [finding],
        diagnostics: [],
      }),
    ).toEqual({
      blockers: [blocker],
      warnings: [warning],
      qualityFindings: [finding],
    });
  });
});
