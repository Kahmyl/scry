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
  type: "observe_document" | "interact" | "suspend" | "resume" | "cancel",
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

  const interact = input?.interactError
    ? vi.fn(async () => {
        throw input.interactError;
      })
    : vi.fn(async () => ({
        documentEpoch: 3,
        url: "https://example.com/settings",
      }));

  const suspend = vi.fn();
  const resume = vi.fn();

  const repository = {
    claimNext: vi
      .fn()
      .mockResolvedValueOnce(runtime)
      .mockResolvedValue(undefined),
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
    expect(repository.recordObservation).toHaveBeenCalledWith(
      runtime.browserLeaseId,
      "worker-1",
      {
        documentEpoch: 2,
        url: "https://example.com/dashboard",
      },
    );
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
    const action = {
      type: "click",
      target: {
        concept: "settings",
        requiredCapabilities: ["pointer_activatable"],
        preferredEvidence: {
          roles: ["link"],
          names: ["Settings"],
          labels: ["Settings"],
          descriptions: [],
          placeholders: [],
          inputTypes: [],
        },
        scope: { kind: "page" },
        relations: [],
        prohibited: ["hidden", "disabled"],
        risk: "read_only",
        confidence: {
          requiredFamilies: [],
          minimum: 0.35,
          minimumMargin: 0,
          minimumFamilyCount: 1,
        },
      },
      expectedEffect: {
        type: "navigation",
        url: "/settings",
        match: "path",
      },
    };

    const claimed = command("interact", { action });
    const { owner, repository, commands, interact } = harness({
      commands: [claimed],
    });

    await owner.start();

    await vi.waitFor(() => expect(commands.complete).toHaveBeenCalledOnce());

    expect(interact).toHaveBeenCalledWith(action);
    expect(repository.recordObservation).toHaveBeenCalledWith(
      runtime.browserLeaseId,
      "worker-1",
      {
        documentEpoch: 3,
        url: "https://example.com/settings",
      },
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

    await vi.waitFor(() =>
      expect(commands.complete).toHaveBeenCalledTimes(2),
    );

    expect(suspend).toHaveBeenCalledOnce();
    expect(repository.suspend).toHaveBeenCalledWith(
      runtime.browserLeaseId,
      "worker-1",
    );

    expect(resume).toHaveBeenCalledOnce();
    expect(repository.resume).toHaveBeenCalledWith(
      runtime.browserLeaseId,
      "worker-1",
    );

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

    expect(commands.cancelPending).toHaveBeenCalledWith(
      runtime.probeSessionId,
      claimed.id,
    );
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
