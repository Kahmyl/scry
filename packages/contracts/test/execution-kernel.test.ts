import { describe, expect, it } from "vitest";

import {
  agentDecisionBoundarySchema,
  executionCapabilityNameSchema,
  operationOutcomeSchema,
} from "../src/execution-kernel.js";

describe("execution kernel contracts", () => {
  it("models protected input independently from protected operations", () => {
    expect(executionCapabilityNameSchema.parse("protected_input")).toBe("protected_input");
    expect(() => executionCapabilityNameSchema.parse("protected_input_unknown")).toThrow();
  });

  it("admits the applied-but-unverified observation boundary", () => {
    const boundary = {
      type: "effect_observation_required" as const,
      reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED",
      safeActions: ["get_flow_authoring", "advance_flow_authoring"],
    };
    expect(agentDecisionBoundarySchema.parse(boundary)).toEqual(boundary);
    expect(
      operationOutcomeSchema.parse({
        operationId: "applied-effect",
        functionalResult: "failed",
        mutationOutcome: "applied",
        privacyResult: "unverified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
        reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED",
        nextDecisionBoundary: boundary,
      }),
    ).toMatchObject({ mutationOutcome: "applied", nextDecisionBoundary: boundary });
  });

  it("models an actionable trusted-script-origin recovery without authorizing it", () => {
    expect(
      agentDecisionBoundarySchema.parse({
        type: "environment_unavailable",
        reasonCode: "ENVIRONMENT_TRUSTED_SCRIPT_ORIGIN_REQUIRED",
        safeActions: ["create_test_environment", "create_flow_draft", "start_flow_authoring"],
        environmentRecovery: {
          environmentId: "11111111-1111-4111-8111-111111111111",
          missingTrustedScriptOrigins: ["https://scripts.example.test"],
          missingOriginClassification: "public",
          currentTrustedScriptOrigins: [],
          recoveryTool: "create_test_environment",
          requiresNewFlowDraftAndAuthoringSession: true,
        },
      }),
    ).toMatchObject({
      environmentRecovery: { missingTrustedScriptOrigins: ["https://scripts.example.test"] },
    });
  });

  it("admits only bounded authoritative semantic page context", () => {
    const context = {
      schemaVersion: 1 as const,
      authority: {
        pageId: "page-1",
        documentEpoch: 7,
        url: "https://example.test/developer",
        title: "Developer",
        readiness: "stable" as const,
      },
      completeness: { kind: "bounded" as const, observed: 2, returned: 2, truncated: false },
      controls: [
        {
          reference: "context-control-0123456789abcdef0123456789abcdef",
          role: "tab",
          name: "Test mode",
          semanticPurpose: "password",
          valueProtected: true,
          capabilities: ["observe", "activate"] as const,
          selected: true,
        },
      ],
    };
    expect(
      operationOutcomeSchema.parse({
        operationId: "bounded-context",
        functionalResult: "succeeded",
        mutationOutcome: "not_applied",
        privacyResult: "unverified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
        semanticPageContext: context,
      }).semanticPageContext,
    ).toEqual(context);
    expect(() =>
      operationOutcomeSchema.parse({
        operationId: "unbounded-context",
        functionalResult: "succeeded",
        mutationOutcome: "not_applied",
        privacyResult: "unverified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
        semanticPageContext: { ...context, controls: Array(65).fill(context.controls[0]) },
      }),
    ).toThrow();
  });
});
