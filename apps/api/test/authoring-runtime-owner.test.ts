import { describe, expect, it, vi } from "vitest";

import { createAuthoringRuntimeOwner } from "../src/workers/index.js";

const runtime = {
  probeSessionId: "11111111-1111-4111-8111-111111111111",
  browserLeaseId: "22222222-2222-4222-8222-222222222222",
  environmentId: "33333333-3333-4333-8333-333333333333",
  policy: {
    allowedOrigins: ["https://example.com"],
    allowPrivateNetwork: false,
  },
};

function command(
  type: "observe_document" | "interact" | "advance_turn" | "suspend" | "resume" | "cancel",
  payload: Record<string, unknown> = {},
) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    probeSessionId: runtime.probeSessionId,
    browserLeaseId: runtime.browserLeaseId,
    type,
    payload,
    claimToken: "55555555-5555-4555-8555-555555555555",
  };
}

function harness(input?: {
  commands?: ReturnType<typeof command>[];
  observeError?: Error;
  interactError?: Error;
  interactNever?: boolean;
  interactionResults?: Array<{
    documentEpoch: number;
    url: string;
    outcome: import("@scry/contracts").OperationOutcome;
  }>;
}) {
  const close = vi.fn(async () => undefined);
  const observeDocument = input?.observeError
    ? vi.fn(async () => {
        throw input.observeError;
      })
    : vi.fn(async () => ({
        documentEpoch: 2,
        url: "https://example.com/dashboard",
      }));

  const interactionResults = [...(input?.interactionResults ?? [])];
  const interact = input?.interactNever
    ? vi.fn(
        (_action, context?: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            context?.signal?.addEventListener(
              "abort",
              () => reject(context.signal?.reason ?? new Error("ABORTED")),
              { once: true },
            );
          }),
      )
    : input?.interactError
      ? vi.fn(async () => {
          throw input.interactError;
        })
      : vi.fn(
          async () =>
            interactionResults.shift() ?? {
              documentEpoch: 3,
              url: "https://example.com/settings",
              outcome: outcome("succeeded", "not_applied"),
            },
        );

  const suspend = vi.fn();
  const resume = vi.fn();

  const repository = {
    claimNext: vi.fn().mockResolvedValueOnce(runtime).mockResolvedValue(undefined),
    activate: vi.fn(async () => true),
    heartbeat: vi.fn(async () => true),
    release: vi.fn(async () => true),
    suspend: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    crash: vi.fn(async () => true),
    recordObservation: vi.fn(async () => true),
  };

  const pending = [...(input?.commands ?? [])];

  const commands = {
    claimNext: vi.fn(async () => pending.shift()),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => true),
    heartbeatClaim: vi.fn(async () => true),
    cancelPending: vi.fn(async () => 0),
  };

  const createSession = vi.fn(async () => ({
    browser: {},
    context: {},
    page: {},
    state: () => "active" as const,
    documentEpoch: () => 0,
    observeDocument,
    interact,
    suspend,
    resume,
    cancelActiveOperation: vi.fn(async () => undefined),
    close,
  }));

  const owner = createAuthoringRuntimeOwner({
    repository: repository as never,
    commands: commands as never,
    workerId: "worker-1",
    browserChannel: "chrome",
    veilAdmissionKey: "test-only-veil-admission-key",
    heartbeatMs: 5,
    pollMs: 5,
    createSession: createSession as never,
  });

  return {
    owner,
    repository,
    commands,
    createSession,
    close,
    observeDocument,
    interact,
    suspend,
    resume,
  };
}

describe("authoring runtime owner", () => {
  it("owns a claimed browser lease until shutdown", async () => {
    const { owner, repository, createSession, close } = harness();

    await owner.start();
    await vi.waitFor(() => expect(repository.activate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(repository.heartbeat).toHaveBeenCalled());

    await owner.close();

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: runtime.probeSessionId,
        environmentId: runtime.environmentId,
      }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(repository.release).toHaveBeenCalledWith(
      runtime.browserLeaseId,
      "worker-1",
      "cancelled",
    );
  });

  it("executes an observation command and persists its safe state", async () => {
    const claimed = command("observe_document");
    const { owner, repository, commands, observeDocument } = harness({
      commands: [claimed],
    });

    await owner.start();

    await vi.waitFor(() => expect(commands.complete).toHaveBeenCalledOnce());

    expect(observeDocument).toHaveBeenCalledOnce();
    expect(repository.recordObservation).toHaveBeenCalledWith(runtime.browserLeaseId, "worker-1", {
      documentEpoch: 2,
      url: "https://example.com/dashboard",
    });
    expect(commands.complete).toHaveBeenCalledWith({
      commandId: claimed.id,
      browserLeaseId: runtime.browserLeaseId,
      workerId: "worker-1",
      claimToken: claimed.claimToken,
      safeResult: {
        documentEpoch: 2,
        url: "https://example.com/dashboard",
      },
    });

    await owner.close();
  });

  it("executes a bounded interaction and records the resulting document", async () => {
    const action = clickAction();

    const claimed = command("interact", { action });
    const { owner, repository, commands, interact } = harness({
      commands: [claimed],
    });

    await owner.start();

    await vi.waitFor(() => expect(commands.complete).toHaveBeenCalledOnce());

    expect(interact).toHaveBeenCalledWith(action, {
      operationId: `authoring-command-${claimed.id}`,
    });
    expect(repository.recordObservation).toHaveBeenCalledWith(runtime.browserLeaseId, "worker-1", {
      documentEpoch: 3,
      url: "https://example.com/settings",
    });

    await owner.close();
  });

  it("executes a deterministic operation group and returns one compact terminal boundary", async () => {
    const claimed = command(
      "advance_turn",
      turnPayload([
        { operationId: "navigate", action: { type: "navigate", url: "https://example.com" } },
        { operationId: "settings", action: clickAction() },
      ]),
    );
    const { owner, commands, observeDocument, interact } = harness({ commands: [claimed] });

    await owner.start();
    await vi.waitFor(() => expect(commands.complete).toHaveBeenCalledOnce());

    expect(observeDocument).toHaveBeenCalledOnce();
    expect(interact).toHaveBeenCalledTimes(2);
    expect(interact).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      expect.objectContaining({
        operationId: `authoring-turn-${claimed.id}-navigate-attempt-1`,
        mutationIdentity: `authoring-turn-${claimed.id}-navigate`,
        objectiveDelta: "Reach settings",
      }),
    );
    expect(commands.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        safeResult: expect.objectContaining({
          operationsCompleted: expect.arrayContaining([
            expect.objectContaining({ operationId: "navigate" }),
            expect.objectContaining({ operationId: "settings" }),
          ]),
          decisionBoundary: expect.objectContaining({ type: "objective_completed" }),
          bytesReturned: expect.any(Number),
        }),
      }),
    );
    await owner.close();
  });

  it("stops before an unauthorized mutation without dispatching it", async () => {
    const payload = turnPayload([{ operationId: "settings", action: clickAction() }]);
    payload.authorization.mutationAllowed = false;
    const claimed = command("advance_turn", payload);
    const { owner, commands, interact } = harness({ commands: [claimed] });

    await owner.start();
    await vi.waitFor(() => expect(commands.complete).toHaveBeenCalledOnce());

    expect(interact).not.toHaveBeenCalled();
    expect(commands.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        safeResult: expect.objectContaining({
          operationsCompleted: [],
          decisionBoundary: expect.objectContaining({
            type: "authorization_required",
          }),
        }),
      }),
    );
    await owner.close();
  });

  it("executes an authorized protected fill through the grouped kernel callback", async () => {
    const reference = "88888888-8888-4888-8888-888888888888";
    const payload = turnPayload([
      {
        operationId: "credential",
        action: { ...fillAction(), value: undefined, secretRef: reference },
      },
    ]);
    (payload.protectedInputReferences as string[]).push(reference);
    payload.authorization.protectedOperationAllowed = true;
    const claimed = command("advance_turn", payload);
    const { owner, commands, interact } = harness({ commands: [claimed] });

    await owner.start();
    await vi.waitFor(() => expect(commands.complete).toHaveBeenCalledOnce());

    expect(interact).toHaveBeenCalledWith(
      expect.objectContaining({ secretRef: reference }),
      expect.objectContaining({
        operationId: `authoring-turn-${claimed.id}-credential-attempt-1`,
        mutationIdentity: `authoring-turn-${claimed.id}-credential`,
      }),
    );
    expect(commands.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        safeResult: expect.objectContaining({
          decisionBoundary: expect.objectContaining({ type: "objective_completed" }),
        }),
      }),
    );
    await owner.close();
  });

  it("rejects an unused protected reference before browser interaction", async () => {
    const payload = turnPayload([{ operationId: "settings", action: clickAction() }]);
    (payload.protectedInputReferences as string[]).push("88888888-8888-4888-8888-888888888888");
    const claimed = command("advance_turn", payload);
    const { owner, commands, interact } = harness({ commands: [claimed] });

    await owner.start();
    await vi.waitFor(() => expect(commands.fail).toHaveBeenCalledOnce());

    expect(interact).not.toHaveBeenCalled();
    expect(commands.complete).not.toHaveBeenCalled();
    await owner.close();
  });

  it("fails a fine-grained interaction command with its typed outcome", async () => {
    const claimed = command("interact", { action: clickAction() });
    const failed = {
      ...outcome("failed", "not_applied"),
      reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED",
    };
    const { owner, commands } = harness({
      commands: [claimed],
      interactionResults: [
        { documentEpoch: 3, url: "https://example.com/settings", outcome: failed },
      ],
    });

    await owner.start();
    await vi.waitFor(() => expect(commands.fail).toHaveBeenCalledOnce());

    expect(commands.complete).not.toHaveBeenCalled();
    expect(commands.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        safeError: expect.objectContaining({
          code: "EXPECTED_EFFECT_NOT_OBSERVED",
          outcome: failed,
        }),
      }),
    );
    await owner.close();
  });

  it("treats unknown mutation state as terminal and never retries the operation", async () => {
    const claimed = command(
      "advance_turn",
      turnPayload([
        { operationId: "first", action: clickAction() },
        { operationId: "second", action: clickAction() },
      ]),
    );
    const { owner, commands, interact } = harness({
      commands: [claimed],
      interactionResults: [
        {
          documentEpoch: 3,
          url: "https://example.com/settings",
          outcome: outcome("inconclusive", "unknown"),
        },
      ],
    });

    await owner.start();
    await vi.waitFor(() => expect(commands.complete).toHaveBeenCalledOnce());

    expect(interact).toHaveBeenCalledOnce();
    expect(commands.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        safeResult: expect.objectContaining({
          decisionBoundary: expect.objectContaining({
            type: "mutation_reconciliation_required",
            safeActions: ["reconcile_mutation", "do_not_retry"],
          }),
        }),
      }),
    );
    await owner.close();
  });

  it("refreshes and retries only a proven pre-dispatch transient", async () => {
    const claimed = command(
      "advance_turn",
      turnPayload([{ operationId: "settings", action: clickAction() }]),
    );
    const transient = {
      ...outcome("failed", "not_applied"),
      reasonCode: "PRAXIS_TARGET_CHANGED_BEFORE_ACTION",
    };
    const { owner, commands, interact, observeDocument } = harness({
      commands: [claimed],
      interactionResults: [
        {
          documentEpoch: 2,
          url: "https://example.com/dashboard",
          outcome: transient,
        },
        {
          documentEpoch: 3,
          url: "https://example.com/settings",
          outcome: outcome("succeeded", "applied"),
        },
      ],
    });

    await owner.start();
    await vi.waitFor(() => expect(commands.complete).toHaveBeenCalledOnce());

    expect(interact).toHaveBeenCalledTimes(2);
    expect(observeDocument).toHaveBeenCalledTimes(2);
    expect(commands.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        safeResult: expect.objectContaining({
          decisionBoundary: expect.objectContaining({ type: "objective_completed" }),
          timings: expect.objectContaining({ retryCount: 1 }),
        }),
      }),
    );
    await owner.close();
  });

  it("enforces the total turn deadline while an interaction is still pending", async () => {
    const payload = turnPayload([{ operationId: "settings", action: clickAction() }]);
    payload.budgets.maxDurationMs = 1_000;
    const claimed = command("advance_turn", payload);
    const { owner, commands } = harness({ commands: [claimed], interactNever: true });

    await owner.start();
    await vi.waitFor(() => expect(commands.complete).toHaveBeenCalledOnce(), { timeout: 2_000 });

    expect(commands.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        safeResult: expect.objectContaining({
          decisionBoundary: expect.objectContaining({
            type: "turn_budget_exhausted",
            reasonCode: "AUTHORING_TURN_BUDGET_EXHAUSTED",
          }),
        }),
      }),
    );
    await owner.close();
  });

  it("suspends and resumes one retained browser session", async () => {
    const suspendCommand = command("suspend");
    const resumeCommand = {
      ...command("resume"),
      id: "66666666-6666-4666-8666-666666666666",
      claimToken: "77777777-7777-4777-8777-777777777777",
    };

    const { owner, repository, commands, suspend, resume } = harness({
      commands: [suspendCommand, resumeCommand],
    });

    await owner.start();

    await vi.waitFor(() => expect(commands.complete).toHaveBeenCalledTimes(2));

    expect(suspend).toHaveBeenCalledOnce();
    expect(repository.suspend).toHaveBeenCalledWith(runtime.browserLeaseId, "worker-1");

    expect(resume).toHaveBeenCalledOnce();
    expect(repository.resume).toHaveBeenCalledWith(runtime.browserLeaseId, "worker-1");

    await owner.close();
  });

  it("cancels the runtime, queued commands, and retained browser", async () => {
    const claimed = command("cancel");
    const { owner, repository, commands, close } = harness({
      commands: [claimed],
    });

    await owner.start();

    await vi.waitFor(() =>
      expect(repository.release).toHaveBeenCalledWith(
        runtime.browserLeaseId,
        "worker-1",
        "cancelled",
      ),
    );

    expect(commands.cancelPending).toHaveBeenCalledWith(runtime.probeSessionId, claimed.id);
    expect(commands.complete).toHaveBeenCalledWith({
      commandId: claimed.id,
      browserLeaseId: runtime.browserLeaseId,
      workerId: "worker-1",
      claimToken: claimed.claimToken,
      safeResult: {
        state: "cancelled",
      },
    });
    expect(close).toHaveBeenCalledOnce();

    await owner.close();
  });

  it("fails the command and crashes the runtime after a session failure", async () => {
    const claimed = command("observe_document");
    const { owner, repository, commands, close } = harness({
      commands: [claimed],
      observeError: new Error("browser disconnected"),
    });

    await owner.start();

    await vi.waitFor(() => expect(repository.crash).toHaveBeenCalledOnce());

    expect(commands.fail).toHaveBeenCalledWith({
      commandId: claimed.id,
      browserLeaseId: runtime.browserLeaseId,
      workerId: "worker-1",
      claimToken: claimed.claimToken,
      safeError: {
        code: "AUTHORING_COMMAND_FAILED",
      },
    });
    expect(repository.crash).toHaveBeenCalledWith(
      runtime.browserLeaseId,
      "worker-1",
      "AUTHORING_COMMAND_FAILED",
    );
    expect(close).toHaveBeenCalledOnce();

    await owner.close();
  });
});

function clickAction() {
  return {
    type: "click" as const,
    target: {
      concept: "settings",
      requiredCapabilities: ["pointer_activatable" as const],
      preferredEvidence: {
        roles: ["link" as const],
        names: ["Settings"],
        labels: ["Settings"],
        descriptions: [],
        placeholders: [],
        inputTypes: [],
      },
      scope: { kind: "page" as const },
      relations: [],
      prohibited: ["hidden" as const, "disabled" as const],
      risk: "read_only" as const,
      confidence: {
        requiredFamilies: [],
        minimum: 0.35,
        minimumMargin: 0,
        minimumFamilyCount: 1,
      },
    },
    expectedEffect: { type: "navigation" as const, url: "/settings", match: "path" as const },
  };
}

function fillAction() {
  return {
    type: "fill" as const,
    target: {
      concept: "password",
      requiredCapabilities: ["accepts_text" as const, "focusable" as const, "editable" as const],
      preferredEvidence: {
        roles: ["textbox" as const],
        names: ["Password"],
        labels: ["Password"],
        descriptions: [],
        placeholders: [],
        inputTypes: ["password"],
      },
      scope: { kind: "page" as const },
      relations: [],
      prohibited: ["hidden" as const, "disabled" as const],
      risk: "protected" as const,
      confidence: {
        requiredFamilies: [],
        minimum: 0.35,
        minimumMargin: 0,
        minimumFamilyCount: 1,
      },
    },
    value: "placeholder",
  };
}

function turnPayload(operations: Array<{ operationId: string; action: Record<string, unknown> }>) {
  return {
    objectiveDelta: "Reach settings",
    operations: operations.map((operation) => ({
      ...operation,
      expectedEffect: { type: "none" as const },
    })),
    authorization: { mutationAllowed: true, protectedOperationAllowed: false },
    budgets: { maxOperations: operations.length, maxDurationMs: 5_000, maxPreDispatchRetries: 1 },
    protectedInputReferences: [],
  };
}

function outcome(
  functionalResult: "succeeded" | "failed" | "inconclusive",
  mutationOutcome: "not_applied" | "applied" | "unknown",
): import("@scry/contracts").OperationOutcome {
  return {
    operationId: "kernel-operation",
    functionalResult,
    mutationOutcome,
    privacyResult: "verified",
    evidenceResult: [],
    qualityFindings: [],
    durationMs: 1,
  };
}
