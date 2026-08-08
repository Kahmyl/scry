import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyProbeCompilationInput,
  compiledContractDigest,
  compileSuccessfulInteractions,
  sanitizeLearnedRecord,
  sanitizeProtectedAcquisitionEvidence,
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
  veilEvidenceClosed: true,
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

  it("rejects unsafe evidence before sanitization can make it appear compilable", () => {
    vi.stubEnv("SCRY_TRANSCRIPT_COMPILER_ENABLED", "true");

    const encodedSecret = Buffer.from("password=never-persist-this").toString("base64");
    const result = compileSuccessfulInteractions({
      learnedContracts: [
        { ...passedRecord, interactionId: "coordinates", point: { x: 10, y: 20 } },
        { ...passedRecord, interactionId: "screenshot", screenshot: "capture.png" },
        { ...passedRecord, interactionId: "encoded", evidence: encodedSecret },
      ],
    });

    expect(result.learnedRecords).toEqual([]);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "FORBIDDEN_LEARNED_EVIDENCE",
      "FORBIDDEN_LEARNED_EVIDENCE",
      "ENCODED_PROTECTED_VALUE_REJECTED",
    ]);
  });

  it("rejects expired handles, missing effects, and unclosed Veil evidence", () => {
    vi.stubEnv("SCRY_TRANSCRIPT_COMPILER_ENABLED", "true");

    const result = compileSuccessfulInteractions({
      learnedContracts: [
        {
          ...passedRecord,
          interactionId: "expired",
          ephemeralHandleExpiresAt: "2020-01-01T00:00:00.000Z",
        },
        { ...passedRecord, interactionId: "effect", expectedEffectVerified: false },
        { ...passedRecord, interactionId: "veil", veilEvidenceClosed: false },
      ],
    });

    expect(result.learnedRecords).toEqual([]);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "EPHEMERAL_HANDLE_EXPIRED",
      "EXPECTED_EFFECT_REQUIRED",
      "VEIL_EVIDENCE_NOT_CLOSED",
    ]);
  });

  it("retains only sanitized protected acquisition closure proof", () => {
    const proof = {
      reference: "clientSecret",
      adapter: "copy_control",
      objective: "verify_user_copy_experience",
      outcome: "copy_experience_verified",
      capsule: "destroyed",
      evidenceClosure: "resumed",
    };

    expect(
      sanitizeProtectedAcquisitionEvidence([
        { ...proof, plaintext: "must-not-persist", clipboardValue: "must-not-persist" },
        { ...proof, reference: "unsafe", capsule: "active" },
      ]),
    ).toEqual([proof]);
  });

  it("binds sanitized protected acquisition proof to transcript compilation output", () => {
    vi.stubEnv("SCRY_TRANSCRIPT_COMPILER_ENABLED", "true");
    const proof = {
      reference: "clientSecret",
      adapter: "keyboard_copy",
      objective: "verify_user_copy_experience",
      outcome: "copy_experience_verified",
      capsule: "destroyed",
      evidenceClosure: "resumed",
    };

    expect(
      compileSuccessfulInteractions({
        learnedContracts: [passedRecord],
        protectedAcquisitionEvidence: [proof],
      }).protectedAcquisitionEvidence,
    ).toEqual([proof]);

    const baseContract = {
      version: "v2-learned-interactions",
      planDigest: "a".repeat(64),
      learnedInteractionRecords: [passedRecord],
    };
    expect(
      compiledContractDigest({
        ...baseContract,
        protectedAcquisitionEvidence: [proof],
      }),
    ).not.toBe(
      compiledContractDigest({
        ...baseContract,
        protectedAcquisitionEvidence: [],
      }),
    );
  });
});
