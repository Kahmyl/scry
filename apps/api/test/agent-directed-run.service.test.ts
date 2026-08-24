import { describe, expect, it, vi } from "vitest";

import { AgentDirectedRunService } from "../src/runs/services/agent-directed-run.service.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const objectiveId = "33333333-3333-4333-8333-333333333333";
const flowDraftId = "44444444-4444-4444-8444-444444444444";

const intent = {
  intentId: "activate-submit",
  objectiveId,
  flowDraftId,
  action: {
    kind: "activate" as const,
    target: {
      concept: "Submit",
      reference: `context-control-${"a".repeat(32)}`,
      role: "button" as const,
      exact: true,
    },
  },
  expectedEffect: {
    kind: "target_state" as const,
    target: {
      concept: "Done",
      reference: `context-control-${"b".repeat(32)}`,
      role: "text" as const,
      exact: true,
    },
    enabled: true,
  },
  constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: false },
  authorization: { kind: "ordinary" as const },
  protectedInputReferences: [],
};

function harness(associated = true, existingSafeResult?: Record<string, unknown>) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM run_operation_links") && sql.includes("operation_id"))
      return existingSafeResult
        ? { rowCount: 1, rows: [{ operationId: "m2-operation", safeResult: existingSafeResult }] }
        : { rowCount: 0, rows: [] };
    if (sql.includes('operation_id AS "operationId"'))
      return { rowCount: 1, rows: [{ operationId: "m2-operation" }] };
    if (sql.includes("FROM runs r") && sql.includes("run_praxis_sessions"))
      return associated
        ? {
            rowCount: 1,
            rows: [
              {
                objectiveId,
                flowDraftId,
                attemptId: "11111111-1111-4111-8111-111111111111",
                claimToken: "22222222-2222-4222-8222-222222222222",
                veilPolicySnapshot: {},
              },
            ],
          }
        : { rowCount: 0, rows: [] };
    if (sql.includes("FROM artifacts")) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{}] };
  });
  const client = {
    query: vi.fn(async (sql: string) =>
      sql.includes("max(sequence)")
        ? { rowCount: 1, rows: [{ sequence: 1 }] }
        : { rowCount: 1, rows: [{}] },
    ),
  };
  const database = {
    query,
    transaction: vi.fn((work: (value: typeof client) => unknown) => work(client)),
  };
  const scry = { requireWriteAccess: vi.fn(), getRun: vi.fn(async () => ({ id: runId })) };
  const sessions = {
    advance: vi.fn(async (_principal: unknown, _sessionId: string, command: any): Promise<any> => ({
      completed: [
        {
          intentId: command.intents[0].intentId,
          functionalResult: "succeeded",
          mutationOutcome: "applied",
          privacyApplicable: false,
          privacyResult: "verified",
          evidence: { state: "available", count: 0, reasonCodes: [] },
          semanticPageContext: {
            schemaVersion: 2,
            authority: {
              pageId: "page-1",
              documentEpoch: 2,
              url: "https://example.test/next",
              title: "Next",
              readiness: "stable",
            },
            completeness: { kind: "bounded", observed: 0, returned: 0, truncated: false },
            controls: [],
            containers: [],
            containerCompleteness: {
              kind: "bounded",
              observed: 0,
              returned: 0,
              truncated: false,
            },
          },
        },
      ],
    })),
  };
  const executions = {};
  const admission = { assertAcceptingWork: vi.fn() };
  return {
    service: new AgentDirectedRunService(
      database as never,
      scry as never,
      sessions as never,
      executions as never,
      { getMutationReceiptByAuthoringOperation: vi.fn(async () => undefined) } as never,
      admission as never,
    ),
    sessions,
  };
}

describe("agent-directed Run live Praxis ownership", () => {
  it("dispatches one exact-reference operation and preserves expected effects as mechanical assertions only", async () => {
    const { service, sessions } = harness();
    await expect(
      service.dispatch({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        intent,
      }),
    ).resolves.toMatchObject({
      runId,
      praxisSessionId: sessionId,
      operationId: "m2-operation",
      intentId: "activate-submit",
      functionalResult: "succeeded",
      mutationOutcome: "applied",
      successorObservation: {
        documentEpoch: 2,
        url: "https://example.test/next",
      },
    });
    expect(sessions.advance).toHaveBeenCalledWith(
      expect.anything(),
      sessionId,
      expect.objectContaining({
        intents: [expect.objectContaining({ expectedEffect: intent.expectedEffect })],
        budgets: { maxOperations: 1, maxDurationMs: 5_000 },
      }),
      expect.objectContaining({
        commit: expect.any(Function),
        outputDirectoryFor: expect.any(Function),
      }),
    );
  });

  it("refuses a Run/session mismatch before invoking Praxis", async () => {
    const { service, sessions } = harness(false);
    await expect(
      service.dispatch({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        intent,
      }),
    ).rejects.toMatchObject({ response: { code: "RUN_PRAXIS_SESSION_MISMATCH_OR_STALE" } });
    expect(sessions.advance).not.toHaveBeenCalled();
  });

  it("projects a predispatch protected-session prerequisite without hiding it as a missing result", async () => {
    const { service, sessions } = harness();
    sessions.advance.mockResolvedValueOnce({
      state: "decision_required",
      completed: [],
      decisionBoundary: {
        type: "authorization_required",
        reasonCode: "MISSION_AUTHORING_PROTECTED_SESSION_REQUIRED",
        safeActions: ["start_praxis_session", "attach_run_praxis_session"],
      },
    });

    await expect(
      service.dispatch({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        intent,
      }),
    ).rejects.toMatchObject({
      response: {
        code: "MISSION_AUTHORING_PROTECTED_SESSION_REQUIRED",
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
        safeActions: ["start_praxis_session", "attach_run_praxis_session"],
      },
    });
  });

  it("projects the fresh intent identity required after protected-reference admission", async () => {
    const { service, sessions } = harness();
    sessions.advance.mockResolvedValueOnce({
      state: "decision_required",
      completed: [],
      decisionBoundary: {
        type: "authorization_required",
        reasonCode: "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED",
        safeActions: ["authorize_environment_credentials", "dispatch_run_operation"],
        requiresFreshIntentId: true,
      },
    });

    await expect(
      service.dispatch({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        intent,
      }),
    ).rejects.toMatchObject({
      response: {
        code: "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED",
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
        safeActions: ["authorize_environment_credentials", "dispatch_run_operation"],
        requiresFreshIntentId: true,
      },
    });
  });

  it("preserves a completed popup-policy failure and its exact recovery boundary", async () => {
    const { service, sessions } = harness();
    sessions.advance.mockResolvedValueOnce({
      state: "decision_required",
      completed: [
        {
          intentId: intent.intentId,
          functionalResult: "failed",
          mutationOutcome: "not_applied",
          privacyApplicable: false,
          privacyResult: "verified",
          evidence: { state: "available", count: 1, reasonCodes: [] },
          reasonCode: "POPUP_NOT_ALLOWED",
        },
      ],
      decisionBoundary: {
        type: "environment_unavailable",
        reasonCode: "POPUP_NOT_ALLOWED",
        safeActions: ["create_test_environment", "create_flow_draft"],
        popupRecovery: {
          environmentId: "55555555-5555-4555-8555-555555555555",
          currentAllowPopups: false,
          requiredAllowPopups: true,
          currentAllowedOrigins: ["https://example.test"],
          recoveryTools: ["create_test_environment", "create_flow_draft"],
          requiresNewFlowDraftAndAuthoringSession: true,
        },
      },
    });

    await expect(
      service.dispatch({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        intent,
      }),
    ).resolves.toMatchObject({
      functionalResult: "failed",
      mutationOutcome: "not_applied",
      reasonCode: "POPUP_NOT_ALLOWED",
      decisionBoundary: {
        type: "environment_unavailable",
        reasonCode: "POPUP_NOT_ALLOWED",
        safeActions: ["create_test_environment", "create_flow_draft"],
        popupRecovery: {
          currentAllowPopups: false,
          requiredAllowPopups: true,
        },
      },
    });
  });

  it("replays the persisted exact successor observation without redispatch", async () => {
    const persisted = {
      runId,
      praxisSessionId: sessionId,
      operationId: "m2-operation",
      artifactRefs: [],
      intentId: intent.intentId,
      functionalResult: "succeeded",
      mutationOutcome: "not_applied",
      privacyApplicable: false,
      privacyResult: "verified",
      evidence: { state: "available", count: 0, reasonCodes: [] },
      successorObservation: {
        documentEpoch: 7,
        url: "https://example.test/replayed",
        semanticPageContext: {
          schemaVersion: 2,
          authority: {
            pageId: "page-replayed",
            documentEpoch: 7,
            url: "https://example.test/replayed",
            title: "Replayed",
            readiness: "stable",
          },
          completeness: { kind: "bounded", observed: 0, returned: 0, truncated: false },
          controls: [],
        },
      },
      replayed: false,
    };
    const { service, sessions } = harness(true, persisted);
    await expect(
      service.dispatch({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        intent,
      }),
    ).resolves.toMatchObject({
      replayed: true,
      successorObservation: {
        documentEpoch: 7,
        url: "https://example.test/replayed",
      },
    });
    expect(sessions.advance).not.toHaveBeenCalled();
  });

  it("continues only the same pending protected operation until it settles", async () => {
    vi.useFakeTimers();
    try {
      const { service, sessions } = harness();
      sessions.advance
        .mockResolvedValueOnce({ state: "pending", turnId: "protected-turn", completed: [] })
        .mockResolvedValueOnce({
          state: "completed",
          completed: [
            {
              intentId: intent.intentId,
              functionalResult: "succeeded",
              mutationOutcome: "applied",
              privacyApplicable: false,
              privacyResult: "verified",
              evidence: { state: "available", count: 0, reasonCodes: [] },
            },
          ],
        });
      const pending = service.dispatch({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        intent,
      });
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toMatchObject({ intentId: intent.intentId });
      expect(sessions.advance).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        sessionId,
        {
          kind: "continue",
          turnId: "protected-turn",
          budgets: { maxOperations: 1, maxDurationMs: 5_000 },
          idempotencyKey: `${intent.intentId}:continue:1`,
        },
        expect.objectContaining({
          commit: expect.any(Function),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
