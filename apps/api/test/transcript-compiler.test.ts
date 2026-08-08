import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyProbeCompilationInput,
  compileSuccessfulInteractions,
  sanitizeLearnedRecord,
} from "../src/authoring/authoring.service.js";

const passedRecord = {
  interactionId: "interaction-1",
  stepId: "open-orders",
  intent: { concept: "Orders" },
  operation: { type: "activate" },
  functionalResult: "passed",
  mutationOutcome: "applied",
  successfulEvidenceFamilies: ["accessibility", "effect"],
  scope: { kind: "page" },
  relationships: [],
  capabilityProfile: { canActivate: true },
  expectedEffect: { type: "navigation" },
  sanitizedFingerprint: { digest: "a".repeat(64) },
  qualityFindings: [{ code: "INTERACTIVE_DIV_WITHOUT_ROLE" }],
};

describe("authoring transcript compiler", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps malformed-control quality findings non-blocking", () => {
    expect(
      classifyProbeCompilationInput({
        diagnostics: [
          { code: "INTERACTIVE_DIV_WITHOUT_ROLE" },
          { code: "HIDDEN_DUPLICATE_CONTROL" },
          { code: "CANVAS_ONLY_INTERACTION" },
        ],
      }),
    ).toEqual({
      blockers: [],
      warnings: [],
      qualityFindings: [
        { code: "INTERACTIVE_DIV_WITHOUT_ROLE" },
        { code: "HIDDEN_DUPLICATE_CONTROL" },
        { code: "CANVAS_ONLY_INTERACTION" },
      ],
    });
  });

  it("sanitizes authoring-only and secret-bearing fields from learned records", () => {
    expect(
      JSON.stringify(
        sanitizeLearnedRecord({
          ...passedRecord,
          rawSelector: "#token",
          candidateHandle: "candidate-1",
          rawDom: "<html>secret</html>",
          nested: {
            clipboardValue: "secret",
            kept: "safe",
          },
        }),
      ),
    ).toBe(JSON.stringify({ ...passedRecord, nested: { kept: "safe" } }));
  });

  it("compiles only successful deterministic learned interactions", () => {
    vi.stubEnv("SCRY_TRANSCRIPT_COMPILER_ENABLED", "true");

    expect(
      compileSuccessfulInteractions({
        learnedContracts: [passedRecord],
      }),
    ).toMatchObject({
      blockers: [],
      contractVersion: "v2-learned-interactions",
      learnedRecords: [passedRecord],
    });
  });

  it("rejects selector-hint-only and unresolved mutation records", () => {
    vi.stubEnv("SCRY_TRANSCRIPT_COMPILER_ENABLED", "true");

    expect(
      compileSuccessfulInteractions({
        learnedContracts: [
          { ...passedRecord, interactionId: "selector", usedSelectorHint: true },
          { ...passedRecord, interactionId: "mutation", mutationOutcome: "unknown" },
        ],
      }).blockers.map((blocker) => blocker.code),
    ).toEqual(["SELECTOR_HINT_ONLY_CONTRACT_REJECTED", "MUTATION_STATE_UNRESOLVED"]);
  });
});
