import { describe, expect, it, vi } from "vitest";

import { createAuthoringRuntimeOwner } from "../src/workers/index.js";

describe("authoring runtime owner", () => {
  it("owns a claimed browser lease until shutdown", async () => {
    const close = vi.fn(async () => undefined);
    const repository = {
      claimNext: vi.fn(async () => ({
        probeSessionId: "11111111-1111-4111-8111-111111111111",
        browserLeaseId: "22222222-2222-4222-8222-222222222222",
        environmentId: "33333333-3333-4333-8333-333333333333",
        policy: {
          allowedOrigins: ["https://example.com"],
          allowPrivateNetwork: false,
        },
      })),
      activate: vi.fn(async () => true),
      heartbeat: vi.fn(async () => true),
      release: vi.fn(async () => true),
    };

    const createSession = vi.fn(async () => ({
      browser: {},
      context: {},
      page: {},
      state: () => "active" as const,
      documentEpoch: () => 0,
      observeDocument: vi.fn(),
      close,
    }));

    const owner = createAuthoringRuntimeOwner({
      repository: repository as never,
      workerId: "worker-1",
      browserChannel: "chrome",
      veilAdmissionKey: "test-only-veil-admission-key",
      heartbeatMs: 5,
      pollMs: 5,
      createSession: createSession as never,
    });

    await owner.start();
    await vi.waitFor(() => expect(repository.activate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(repository.heartbeat).toHaveBeenCalled());

    await owner.close();

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "11111111-1111-4111-8111-111111111111",
        environmentId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(repository.release).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      "worker-1",
      "cancelled",
    );
  });
});
