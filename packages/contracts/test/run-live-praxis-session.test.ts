import { describe, expect, it } from "vitest";

import { dispatchedRunOperationResultSchema, dispatchRunOperationSchema } from "../src/flow.js";
import { agentRunObservationSchema } from "../src/run.js";

const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

function command(reference?: string, praxisSessionId = id("1")) {
  return {
    praxisSessionId,
    intent: {
      intentId: "activate-submit",
      objectiveId: id("2"),
      flowDraftId: id("3"),
      action: {
        kind: "activate",
        target: { concept: "Submit", ...(reference ? { reference } : {}), role: "button" },
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" },
      protectedInputReferences: [],
    },
  };
}

describe("agent-directed Run live Praxis binding", () => {
  it("requires an exact live reference for every target-bearing operation", () => {
    expect(dispatchRunOperationSchema.safeParse(command()).success).toBe(false);
    expect(
      dispatchRunOperationSchema.parse(command(`context-control-${"a".repeat(32)}`)).intent.action,
    ).toMatchObject({ kind: "activate" });
  });

  it("carries an explicit dispatch session identity independently of target semantics", () => {
    const parsed = dispatchRunOperationSchema.parse(
      command(`context-control-${"b".repeat(32)}`, id("4")),
    );
    expect(parsed.praxisSessionId).toBe(id("4"));
  });

  it("projects the exact current Praxis association separately from launch provenance", () => {
    const observation = agentRunObservationSchema.parse({
      run: {
        id: id("1"),
        state: "running",
        executionSnapshot: { praxisSessionId: id("2") },
        currentPraxisSession: { id: id("3"), epoch: 2, state: "active" },
      },
      steps: [],
      artifacts: [],
      artifactTimeline: [],
      integrity: { status: "complete", issues: [] },
      safeActions: [],
    });

    expect(observation.run).toMatchObject({
      executionSnapshot: { praxisSessionId: id("2") },
      currentPraxisSession: { id: id("3"), epoch: 2, state: "active" },
    });
  });

  it("binds a successor observation to its exact document authority", () => {
    const result = {
      runId: id("1"),
      praxisSessionId: id("2"),
      operationId: "operation-1",
      artifactRefs: [],
      intentId: "intent-1",
      functionalResult: "succeeded",
      mutationOutcome: "not_applied",
      privacyApplicable: false,
      privacyResult: "verified",
      evidence: { state: "available", count: 0, reasonCodes: [] },
      successorObservation: {
        documentEpoch: 4,
        url: "https://example.test/next",
        semanticPageContext: {
          schemaVersion: 2,
          authority: {
            pageId: "page-1",
            documentEpoch: 4,
            url: "https://example.test/next",
            title: "Next",
            readiness: "stable",
          },
          completeness: { kind: "bounded", observed: 0, returned: 0, truncated: false },
          controls: [],
        },
      },
      replayed: false,
    };
    expect(dispatchedRunOperationResultSchema.parse(result).successorObservation).toMatchObject({
      documentEpoch: 4,
      url: "https://example.test/next",
    });
    result.successorObservation.documentEpoch = 5;
    expect(dispatchedRunOperationResultSchema.safeParse(result).success).toBe(false);
  });

  it("preserves typed popup recovery in an agent-directed operation result", () => {
    const result = dispatchedRunOperationResultSchema.parse({
      runId: id("1"),
      praxisSessionId: id("2"),
      operationId: "open-documentation",
      artifactRefs: [],
      intentId: "open-documentation",
      functionalResult: "failed",
      mutationOutcome: "not_applied",
      privacyApplicable: false,
      privacyResult: "verified",
      evidence: { state: "available", count: 1, reasonCodes: [] },
      reasonCode: "POPUP_NOT_ALLOWED",
      decisionBoundary: {
        type: "environment_unavailable",
        reasonCode: "POPUP_NOT_ALLOWED",
        safeActions: ["create_test_environment", "create_flow_draft"],
        popupRecovery: {
          environmentId: id("3"),
          currentAllowPopups: false,
          requiredAllowPopups: true,
          currentAllowedOrigins: ["https://app.example.test"],
          recoveryTools: ["create_test_environment", "create_flow_draft"],
          requiresNewFlowDraftAndAuthoringSession: true,
        },
      },
      replayed: false,
    });

    expect(result.decisionBoundary).toMatchObject({
      reasonCode: "POPUP_NOT_ALLOWED",
      popupRecovery: {
        currentAllowPopups: false,
        requiredAllowPopups: true,
      },
    });
  });

  it("defaults an omitted expected effect to a non-authoritative mechanical assertion", () => {
    const input = command(`context-control-${"c".repeat(32)}`);
    delete (input.intent as { expectedEffect?: unknown }).expectedEffect;
    expect(dispatchRunOperationSchema.parse(input).intent.expectedEffect).toEqual({ kind: "none" });
  });

  it("requires the protected mutation target to be pinned without fabricating post-dispatch output references", () => {
    const reference = `context-control-${"d".repeat(32)}`;
    const input = {
      praxisSessionId: id("1"),
      intent: {
        intentId: "issue-credential",
        objectiveId: id("2"),
        flowDraftId: id("3"),
        action: {
          kind: "acquire_protected_outputs",
          preparationIntentIds: ["open-dialog"],
          mutation: { kind: "one_time", target: { concept: "Create", role: "button", reference } },
          outputs: [
            {
              reference: "clientSecret",
              classification: "protected",
              target: {
                concept: "generated secret",
                role: "textbox",
                name: "Client secret",
                exact: true,
              },
              storageName: "Generated client secret",
            },
          ],
        },
        expectedEffect: { kind: "none" },
        constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: false },
        authorization: { kind: "protected_mutation", authorizationId: id("4") },
        protectedInputReferences: [],
      },
    };
    const parsed = dispatchRunOperationSchema.parse(input).intent.action;
    expect(parsed).toMatchObject({
      kind: "acquire_protected_outputs",
      mutation: { target: { reference } },
    });
    if (parsed.kind !== "acquire_protected_outputs") throw new Error("protected action expected");
    expect("reference" in parsed.outputs[0]!.target).toBe(false);
    delete (input.intent.action.mutation.target as { reference?: string }).reference;
    expect(dispatchRunOperationSchema.safeParse(input).success).toBe(false);
  });
});
