import { describe, expect, it } from "vitest";

import {
  adaptiveSessionTransitionSchema,
  adaptiveSessionSchema,
  advanceAdaptiveSessionSchema,
  createFlowDraftSchema,
  missionAuthoringIntentSchema,
  missionAuthoringTurnResultSchema,
  startAdaptiveSessionSchema,
  reconcileAdaptiveOperationSchema,
  adaptiveOperationReconciliationResultSchema,
  grantMissionAuthorizationSchema,
  praxisSessionCloseResultSchema,
  praxisSessionStartResultSchema,
} from "../src/index.js";

const ids = {
  projectId: "00000000-0000-4000-8000-000000000001",
  environmentId: "00000000-0000-4000-8000-000000000002",
  missionId: "00000000-0000-4000-8000-000000000003",
  objectiveId: "00000000-0000-4000-8000-000000000004",
  flowDraftId: "00000000-0000-4000-8000-000000000005",
  protectedReferenceId: "00000000-0000-4000-8000-000000000006",
  authorizationId: "00000000-0000-4000-8000-000000000007",
  turnId: "00000000-0000-4000-8000-000000000008",
};

describe("protected live Praxis session binding", () => {
  const authorization = {
    missionId: ids.missionId,
    objectiveId: ids.objectiveId,
    agentSessionId: ids.turnId,
    environmentId: ids.environmentId,
    kind: "protected_mutation" as const,
    operationId: "issue-secret",
    reason: "Owner approved this exact protected operation",
    confirmedUserAuthorized: true as const,
  };

  it("defaults sessions to ordinary and permits an explicit protected session", () => {
    const base = {
      projectId: ids.projectId,
      missionId: ids.missionId,
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      environmentId: ids.environmentId,
      agentSessionId: ids.turnId,
      objective: "Issue credential",
      allowedOrigins: ["https://example.test"],
      idempotencyKey: "protected-session-contract",
    };
    expect(startAdaptiveSessionSchema.parse(base).protection).toBe("ordinary");
    expect(startAdaptiveSessionSchema.parse({ ...base, protection: "protected" }).protection).toBe(
      "protected",
    );
  });

  it("requires protected authorization to bind an exact Praxis session", () => {
    expect(grantMissionAuthorizationSchema.safeParse(authorization).success).toBe(false);
    expect(
      grantMissionAuthorizationSchema.safeParse({
        ...authorization,
        praxisSessionId: ids.flowDraftId,
      }).success,
    ).toBe(true);
  });
});

const target = { concept: "account email field", label: "Email address" };
const constraints = { timeoutMs: 10_000, allowNewPage: false, allowNonExact: false };
const authorization = { kind: "ordinary" as const };

function intent(overrides: Record<string, unknown> = {}) {
  return {
    intentId: "inspect-account",
    objectiveId: ids.objectiveId,
    flowDraftId: ids.flowDraftId,
    action: { kind: "inspect", target },
    expectedEffect: { kind: "none" },
    constraints,
    authorization,
    protectedInputReferences: [],
    ...overrides,
  };
}

describe("adaptive session contracts", () => {
  it("admits only server-owned UNKNOWN reconciliation decisions", () => {
    const input = {
      missionId: ids.missionId,
      operationId: "uncertain-operation",
      idempotencyKey: "reconcile-unknown-1",
    };
    expect(reconcileAdaptiveOperationSchema.parse(input)).toEqual(input);
    expect(() =>
      reconcileAdaptiveOperationSchema.parse({ ...input, result: "proven_applied" }),
    ).toThrow();
    expect(
      adaptiveOperationReconciliationResultSchema.parse({
        sessionId: ids.turnId,
        operationId: input.operationId,
        originalMutationOutcome: "unknown",
        result: "still_unknown",
        redispatchAllowed: false,
        missionFenceCleared: false,
        reasonCode: "RECONCILIATION_EVIDENCE_INSUFFICIENT",
        replayed: false,
        safeActions: ["get_flow_authoring"],
        requiresFreshIdempotencyKey: true,
        nextAttemptId: ids.authorizationId,
      }).redispatchAllowed,
    ).toBe(false);
  });
  it("starts Mission authoring with bounded default turns and protected references", () => {
    const parsed = startAdaptiveSessionSchema.parse({
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      agentSessionId: ids.turnId,
      missionId: ids.missionId,
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      objective: "Inspect the read-only account details",
      allowedOrigins: ["https://example.test"],
      idempotencyKey: "adaptive-start-1",
    });
    expect(parsed.turnBudgets).toEqual({ maxOperations: 20, maxDurationMs: 60_000 });
    expect(parsed.initialProtectedReferenceIds).toEqual([]);
  });

  it("defaults mutable Flow purposes while retaining the closed M2 purpose set", () => {
    const draft = createFlowDraftSchema.parse({
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      missionId: ids.missionId,
      objectiveId: ids.objectiveId,
      agentSessionId: ids.turnId,
      name: "Setup",
      content: {
        objective: "Setup",
        preconditions: [],
        expectedOutcomes: ["Ready"],
        prohibitedSideEffects: [],
      },
      plan: {
        name: "Setup",
        objective: "Setup",
        preconditions: [],
        allowedOrigins: ["https://example.test"],
        budgets: { maxActions: 1, maxDurationMs: 1_000, maxNavigations: 1 },
        checkpoints: [],
        steps: [
          {
            id: "setup",
            title: "Setup",
            action: { type: "navigate", url: "https://example.test" },
            assertions: [],
            onFailure: "stop",
            evidence: [],
            captureIntent: "final",
          },
        ],
      },
      idempotencyKey: "flow-purpose-default",
    });
    expect(draft.purpose).toBe("primary");
    expect(
      createFlowDraftSchema.parse({
        ...draft,
        idempotencyKey: "flow-purpose-cleanup",
        purpose: "cleanup",
      }).purpose,
    ).toBe("cleanup");
  });

  it("accepts semantic locators and rejects raw mechanics or locator-free targets", () => {
    expect(missionAuthoringIntentSchema.parse(intent()).action).toMatchObject({ kind: "inspect" });
    expect(() =>
      missionAuthoringIntentSchema.parse(
        intent({ action: { kind: "inspect", target: { concept: "account" } } }),
      ),
    ).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse(
        intent({
          action: { kind: "activate", target, semanticEffect: "unknown", selector: "#account" },
        }),
      ),
    ).toThrow();
    expect(() => missionAuthoringIntentSchema.parse(intent({ javascript: "alert(1)" }))).toThrow();
    expect(
      missionAuthoringIntentSchema.parse(
        intent({
          action: {
            kind: "inspect",
            target: {
              concept: "fresh observed protected control",
              reference: "context-control-0123456789abcdef0123456789abcdef",
            },
          },
        }),
      ).action,
    ).toMatchObject({
      target: { reference: "context-control-0123456789abcdef0123456789abcdef" },
    });
  });

  it("requires explicit fail-closed semantics for activate and press", () => {
    for (const action of [
      { kind: "activate", target },
      { kind: "press", target, key: "Enter" },
    ])
      expect(() => missionAuthoringIntentSchema.parse(intent({ action }))).toThrow();

    for (const action of [
      { kind: "activate", target, semanticEffect: "read_context_transition" },
      { kind: "press", target, key: "Enter", semanticEffect: "read_context_transition" },
    ])
      expect(
        missionAuthoringIntentSchema.parse(
          intent({ action, authorization: { kind: "live_read" } }),
        ),
      ).toMatchObject({ action, authorization: { kind: "live_read" } });
  });

  it("binds read-context transitions to live_read while retaining explicit mutation choices", () => {
    for (const kind of [
      "ordinary",
      "authentication",
      "reversible",
      "live_mutation",
      "protected_mutation",
    ] as const)
      expect(() =>
        missionAuthoringIntentSchema.parse(
          intent({
            action: { kind: "activate", target, semanticEffect: "read_context_transition" },
            authorization: { kind },
          }),
        ),
      ).toThrow("read-context transition requires explicit live_read authority");

    for (const semanticEffect of ["resource_mutation", "unknown"] as const)
      expect(
        missionAuthoringIntentSchema.parse(
          intent({ action: { kind: "activate", target, semanticEffect } }),
        ),
      ).toMatchObject({ action: { semanticEffect }, authorization: { kind: "ordinary" } });
  });

  it("accepts one absolute navigation URL through url or the host urlPattern alias", () => {
    expect(
      missionAuthoringIntentSchema.parse(
        intent({
          expectedEffect: {
            kind: "navigation",
            urlPattern: "https://example.test/partner",
            match: "exact",
          },
        }),
      ).expectedEffect,
    ).toMatchObject({ urlPattern: "https://example.test/partner" });
    expect(() =>
      missionAuthoringIntentSchema.parse(
        intent({
          expectedEffect: {
            kind: "navigation",
            urlPattern: "/partner",
            match: "exact",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse(
        intent({
          expectedEffect: {
            kind: "navigation",
            url: "https://example.test/partner",
            urlPattern: "https://example.test/partner",
            match: "exact",
          },
        }),
      ),
    ).toThrow("navigation expected effect accepts url or urlPattern, not both");
  });

  it("requires exact protected references and authorization for live mutation", () => {
    const protectedFill = intent({
      action: { kind: "fill", target, protectedReferenceId: ids.protectedReferenceId },
      protectedInputReferences: [ids.protectedReferenceId],
      authorization: { kind: "authentication" },
    });
    expect(missionAuthoringIntentSchema.parse(protectedFill)).toMatchObject({
      protectedInputReferences: [ids.protectedReferenceId],
    });
    expect(() =>
      missionAuthoringIntentSchema.parse({ ...protectedFill, protectedInputReferences: [] }),
    ).toThrow();
    expect(() => missionAuthoringIntentSchema.parse({ ...protectedFill, authorization })).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse(intent({ authorization: { kind: "live_mutation" } })),
    ).toThrow();
    expect(
      missionAuthoringIntentSchema.parse(
        intent({ authorization: { kind: "live_mutation", authorizationId: ids.authorizationId } }),
      ),
    ).toMatchObject({ authorization: { kind: "live_mutation" } });
  });

  it("rejects grant IDs on authentication authority", () => {
    const protectedFill = intent({
      action: { kind: "fill", target, protectedReferenceId: ids.protectedReferenceId },
      protectedInputReferences: [ids.protectedReferenceId],
      authorization: {
        kind: "authentication",
        authorizationId: ids.authorizationId,
      },
    });

    expect(() => missionAuthoringIntentSchema.parse(protectedFill)).toThrow(
      "authentication_calibration grants are not browser-login authority",
    );
    expect(
      missionAuthoringIntentSchema.parse({
        ...protectedFill,
        authorization: { kind: "authentication" },
      }),
    ).toMatchObject({ authorization: { kind: "authentication" } });
  });

  it("requires one exact operation-scoped binding for protected authentication", () => {
    const reference = "context-control-0123456789abcdef0123456789abcdef";
    const passwordReference = "00000000-0000-4000-8000-000000000009";
    const authentication = intent({
      action: {
        kind: "authenticate",
        fields: [
          {
            target: { concept: "email", reference },
            protectedReferenceId: ids.protectedReferenceId,
          },
          { target: { concept: "password", reference }, protectedReferenceId: passwordReference },
        ],
        submitTarget: { concept: "login", reference },
      },
      authorization: { kind: "authentication" },
      protectedInputReferences: [ids.protectedReferenceId, passwordReference],
    });
    expect(missionAuthoringIntentSchema.parse(authentication).action).toMatchObject({
      kind: "authenticate",
    });
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...authentication,
        constraints: { ...constraints, allowNonExact: true },
      }),
    ).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...authentication,
        authorization: { kind: "live_read" },
      }),
    ).toThrow();
  });

  it("accepts only semantic protected-output acquisition with explicit authorization", () => {
    const acquisition = intent({
      intentId: "generate-credential",
      action: {
        kind: "acquire_protected_outputs",
        preparationIntentIds: ["open-dialog", "fill-name"],
        mutation: {
          kind: "one_time",
          target: { concept: "generate credential", role: "button", name: "Generate", exact: true },
        },
        outputs: [
          {
            reference: "clientId",
            classification: "public",
            target: { concept: "client ID", role: "textbox", name: "Client ID", exact: true },
            storageName: "Client ID",
          },
          {
            reference: "clientSecret",
            classification: "protected",
            target: {
              concept: "client secret",
              role: "textbox",
              name: "Client secret",
              exact: true,
            },
            storageName: "Client secret",
          },
        ],
      },
      authorization: { kind: "protected_mutation", authorizationId: ids.authorizationId },
    });
    expect(missionAuthoringIntentSchema.parse(acquisition).action).toMatchObject({
      kind: "acquire_protected_outputs",
      outputs: [{ reference: "clientId" }, { reference: "clientSecret" }],
    });
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...acquisition,
        authorization: { kind: "protected_mutation" },
      }),
    ).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...acquisition,
        action: { ...acquisition.action, adapterId: "clipboard" },
      }),
    ).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...acquisition,
        action: { ...acquisition.action, selector: "#generate" },
      }),
    ).toThrow();
    const acquisitionAction = acquisition.action as unknown as Record<string, unknown> & {
      outputs: Array<Record<string, unknown>>;
    };
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...acquisition,
        action: {
          ...acquisitionAction,
          outputs: [
            ...acquisitionAction.outputs,
            { ...acquisitionAction.outputs[0], reference: "clientId" },
          ],
        },
      }),
    ).toThrow();
  });

  it("accepts only bounded same-origin requests and authorizes every mutation", () => {
    const request = intent({
      action: {
        kind: "same_origin_request",
        method: "DELETE",
        authentication: "current_browser_session",
        path: "/users/me",
        expectedStatus: { min: 200, max: 299 },
      },
      authorization: { kind: "live_mutation", authorizationId: ids.authorizationId },
    });
    expect(missionAuthoringIntentSchema.parse(request).action).toMatchObject({ method: "DELETE" });
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...request,
        action: { ...request.action, path: "https://evil.test/users/me" },
      }),
    ).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...request,
        action: { ...request.action, headers: { authorization: "x" } },
      }),
    ).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...request,
        action: {
          ...request.action,
          method: "POST",
          body: { protectedReferenceId: ids.protectedReferenceId },
        },
      }),
    ).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...request,
        action: { ...request.action, expectedStatus: { min: 500, max: 200 } },
      }),
    ).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...request,
        action: { ...request.action, response: "raw body" },
      }),
    ).toThrow();
    expect(() => missionAuthoringIntentSchema.parse({ ...request, authorization })).toThrow();
  });

  it("binds credential revocation projection to one authorized mutating intent", () => {
    const revocation = intent({
      action: {
        kind: "activate",
        target: { ...target, role: "button", name: "Revoke", exact: true },
        semanticEffect: "resource_mutation",
      },
      authorization: { kind: "live_mutation", authorizationId: ids.authorizationId },
      credentialLifecycle: {
        effect: "revoke",
        credentialReferenceIds: [ids.protectedReferenceId],
      },
    });
    expect(missionAuthoringIntentSchema.parse(revocation)).toMatchObject({
      credentialLifecycle: { effect: "revoke", credentialReferenceIds: [ids.protectedReferenceId] },
    });
    expect(() => missionAuthoringIntentSchema.parse({ ...revocation, authorization })).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...revocation,
        action: { kind: "inspect", target },
      }),
    ).toThrow();
    expect(() =>
      missionAuthoringIntentSchema.parse({
        ...revocation,
        credentialLifecycle: {
          effect: "revoke",
          credentialReferenceIds: [ids.protectedReferenceId, ids.protectedReferenceId],
        },
      }),
    ).toThrow();
  });

  it("accepts only strict grouped intent and continuation advances", () => {
    expect(
      advanceAdaptiveSessionSchema.parse({
        kind: "intents",
        idempotencyKey: "adaptive-turn-1",
        intents: [intent()],
        budgets: { maxOperations: 1, maxDurationMs: 30_000 },
      }).kind,
    ).toBe("intents");
    expect(
      advanceAdaptiveSessionSchema.parse({
        kind: "continue",
        idempotencyKey: "adaptive-turn-2",
        turnId: ids.turnId,
        budgets: { maxOperations: 1, maxDurationMs: 30_000 },
      }).kind,
    ).toBe("continue");
    expect(() =>
      advanceAdaptiveSessionSchema.parse({
        operationId: "legacy",
        idempotencyKey: "legacy-operation",
      }),
    ).toThrow();
  });

  it("requires stable continuation only for compact pending turn results", () => {
    const result = {
      turnId: ids.turnId,
      state: "pending",
      completed: [],
      stateDelta: { activeObjectiveId: ids.objectiveId, activeFlowDraftId: ids.flowDraftId },
      channels: {
        functional: { state: "pending" },
        mutation: { state: "not_applicable" },
        privacy: { state: "passed" },
        evidence: { state: "pending" },
        quality: { state: "passed" },
      },
      timings: { resolveMs: 1, executeMs: 0, verifyMs: 0, journalMs: 1, totalMs: 2 },
      decisionBoundary: null,
      continuation: { turnId: ids.turnId, phase: "awaiting_navigation" },
    };
    expect(missionAuthoringTurnResultSchema.parse(result).continuation).toEqual(
      result.continuation,
    );
    expect(() =>
      missionAuthoringTurnResultSchema.parse({ ...result, continuation: undefined }),
    ).toThrow();
    expect(() =>
      missionAuthoringTurnResultSchema.parse({ ...result, state: "completed" }),
    ).toThrow();
  });

  it("keeps existing session views and transition contracts intact", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000009",
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      missionId: ids.missionId,
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      correlationId: "00000000-0000-4000-8000-000000000010",
      state: "active" as const,
      version: 1,
      objective: "Authenticate",
      allowedOrigins: ["https://example.test"],
      decisionBoundary: null,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      operations: [],
      events: [],
    };
    expect(adaptiveSessionSchema.parse(base)).toMatchObject({ missionId: ids.missionId });
    expect(praxisSessionStartResultSchema.parse({ ...base, replayed: false })).toMatchObject({
      id: base.id,
      replayed: false,
    });
    expect(
      praxisSessionCloseResultSchema.parse({
        id: base.id,
        state: "completed",
        replayed: false,
      }),
    ).toEqual({ id: base.id, state: "completed", replayed: false });
    expect(() =>
      adaptiveSessionTransitionSchema.parse({
        expectedVersion: 0,
        reason: "pause",
        idempotencyKey: "adaptive-pause-1",
      }),
    ).toThrow();
  });
});
