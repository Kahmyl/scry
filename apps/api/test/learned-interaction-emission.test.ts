import { currentPlanSchema, praxisResultSchema, type PraxisResult } from "@scry/contracts";
import { describe, expect, it, vi } from "vitest";

import { learnedInteractionsFromPraxis } from "../src/authoring/learned-interaction.js";
import { AuthoringRuntimeRepository } from "../src/authoring/index.js";

describe("production learned interaction emission", () => {
  it("emits a deterministic sanitized record only after Praxis success", () => {
    const records = learnedInteractionsFromPraxis(plan(), [success()], {
      veilEvidenceClosed: true,
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      interactionId: "transaction-1",
      stepId: "continue",
      functionalResult: "passed",
      mutationOutcome: "applied",
      expectedEffectVerified: true,
      veilEvidenceClosed: true,
      deterministic: true,
      qualityFindings: [{ code: "INTERACTIVE_DIV_WITHOUT_ROLE" }],
      operation: { type: "activate" },
    });
    expect(JSON.stringify(records[0])).not.toMatch(
      /rawSelector|candidateHandle|coordinate|screenshot|secretValue/i,
    );
  });

  it("does not emit failed, unresolved, or unverified interactions", () => {
    const verified = success();
    expect(
      learnedInteractionsFromPraxis(
        plan(),
        [
          { ...verified, status: "failed" } as never,
          { ...verified, mutationOutcome: "unknown" },
          {
            ...verified,
            verification: { local: "passed", effect: "unknown", effectType: "navigation" },
          },
        ],
        { veilEvidenceClosed: true },
      ),
    ).toEqual([]);
  });

  it("appends emitted records to the durable Probe result without duplicates", async () => {
    const record = learnedInteractionsFromPraxis(plan(), [success()], {
      veilEvidenceClosed: true,
    })[0]!;
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ result: { learnedContracts: [record], diagnostics: [] } }],
      })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const repository = new AuthoringRuntimeRepository({
      transaction: (work: (client: { query: typeof query }) => Promise<unknown>) => work({ query }),
    } as never);

    await repository.recordLearnedInteractions("probe-1", [record]);

    const persisted = JSON.parse(String(query.mock.calls[1]?.[1]?.[1]));
    expect(persisted.learnedContracts).toEqual([record]);
    expect(persisted.authoringTrajectory).toEqual({
      schemaVersion: 1,
      probeSessionId: "probe-1",
      interactionIds: [record.interactionId],
    });
    expect(query.mock.calls[2]?.[1]?.[1]).not.toContain("Continue to the next page");
  });
});

function plan() {
  return currentPlanSchema.parse({
    name: "Learn Continue",
    objective: "Continue to the next page",
    preconditions: [],
    allowedOrigins: ["https://example.test"],
    budgets: { maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 },
    checkpoints: [],
    steps: [
      {
        id: "continue",
        title: "Continue",
        action: {
          type: "click",
          target: {
            concept: "Continue",
            requiredCapabilities: ["pointer_activatable"],
            preferredEvidence: {
              roles: ["button"],
              names: ["Continue"],
              labels: [],
              descriptions: [],
              placeholders: [],
              inputTypes: [],
            },
            scope: { kind: "page" },
            relations: [],
            prohibited: ["hidden", "disabled"],
            risk: "ordinary",
            confidence: { requiredFamilies: [] },
          },
          expectedEffect: { type: "navigation", url: "/next", match: "path" },
        },
        assertions: [],
        onFailure: "stop",
        evidence: [],
        captureIntent: "transient",
        transientJustification: "Compiler fixture",
      },
    ],
  });
}

function success(): Extract<PraxisResult, { status: "succeeded" }> {
  const result = praxisResultSchema.parse({
    schemaVersion: 1,
    status: "succeeded",
    transactionId: "transaction-1",
    operationId: "operation-1",
    stepId: "continue",
    phase: "succeeded",
    mutationOutcome: "applied",
    resolution: {
      target: {
        fingerprint: "a".repeat(64),
        concept: "Continue",
        scopeKind: "page",
        capabilityDigest: "b".repeat(64),
      },
      confidence: 0.96,
      runnerUpMargin: 0.4,
      evidenceFamilies: ["accessibility", "structural"],
      drift: "unchanged",
      strategy: "native_click",
    },
    verification: { local: "passed", effect: "passed", effectType: "navigation" },
    timing: {
      queuedMs: 0,
      observationMs: 1,
      groundingMs: 1,
      revalidationMs: 1,
      dispatchMs: 1,
      localVerificationMs: 1,
      effectVerificationMs: 1,
      totalMs: 7,
      escalationLevel: 0,
      providerTimings: [],
    },
    qualityFindings: [
      {
        code: "INTERACTIVE_DIV_WITHOUT_ROLE",
        severity: "warning",
        confidence: 0.9,
        summary: "The control is a div.",
        remediation: "Use a native button.",
        evidence: {},
      },
    ],
    report: {
      schemaVersion: 1,
      transactionId: "transaction-1",
      operationId: "operation-1",
      stepId: "continue",
      outcome: "succeeded",
      summary: "Praxis completed and verified the interaction.",
      classification: { provenance: "none", mutationOutcome: "applied" },
      intentDigest: "c".repeat(64),
      resolution: {
        target: {
          fingerprint: "a".repeat(64),
          concept: "Continue",
          scopeKind: "page",
          capabilityDigest: "b".repeat(64),
        },
        confidence: 0.96,
        runnerUpMargin: 0.4,
        evidenceFamilies: ["accessibility", "structural"],
        drift: "unchanged",
        strategy: "native_click",
      },
      verification: { local: "passed", effect: "passed", effectType: "navigation" },
      timing: {
        queuedMs: 0,
        observationMs: 1,
        groundingMs: 1,
        revalidationMs: 1,
        dispatchMs: 1,
        localVerificationMs: 1,
        effectVerificationMs: 1,
        totalMs: 7,
        escalationLevel: 0,
        providerTimings: [],
      },
      qualityFindings: [
        {
          code: "INTERACTIVE_DIV_WITHOUT_ROLE",
          severity: "warning",
          confidence: 0.9,
          summary: "The control is a div.",
          remediation: "Use a native button.",
          evidence: {},
        },
      ],
      safeActions: [],
      artifactRefs: [],
    },
  });
  if (result.status !== "succeeded") throw new Error("Expected successful Praxis fixture");
  return result;
}
