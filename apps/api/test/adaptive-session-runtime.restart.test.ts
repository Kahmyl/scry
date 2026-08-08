import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import { createExecutionCapabilityManifest } from "@scry/executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AdaptiveSessionKernelRunner } from "../src/adaptive-sessions/adaptive-session-kernel.runner.js";
import { ExecutionKernelService } from "../src/runtime/index.js";

describe("adaptive session production runtime restart", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<html><body data-path="${request.url}">${request.url}</body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_REQUIRED");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("reconstructs a replacement browser from the last verified journal boundary", async () => {
    vi.stubEnv("VEIL_ADMISSION_KEY", "adaptive-runtime-test-key");
    vi.stubEnv("SCRY_BROWSER_CHANNEL", "");
    const sessionId = randomUUID();
    const environmentId = randomUUID();
    const correlationId = randomUUID();
    let lastObservation: { operationId: string; documentEpoch: number; url: string } | null = null;
    let fencingToken = 0;
    const observations: Array<{ operationId: string; url: string }> = [];
    const repository = {
      runtimeContextFor: vi.fn(async () => ({
        sessionId,
        environmentId,
        correlationId,
        baseOrigin: origin,
        policy: policy(origin),
        lastObservation,
      })),
      claimRuntimeLease: vi.fn(async () => ({ fencingToken: ++fencingToken })),
      heartbeatRuntimeLease: vi.fn(),
      markOperationDispatching: vi.fn(),
      releaseRuntimeLease: vi.fn(async () => true),
      recordVerifiedObservation: vi.fn(async (observation) => {
        lastObservation = observation;
        observations.push({ operationId: observation.operationId, url: observation.url });
      }),
      resolveCredential: vi.fn(),
    };
    const capabilities = capabilityFactory();
    const first = new AdaptiveSessionKernelRunner(
      new ExecutionKernelService(),
      capabilities as never,
      repository as never,
    );
    await first.execute(sessionId, operation("first", `${origin}/details`));
    await first.onModuleDestroy();

    const second = new AdaptiveSessionKernelRunner(
      new ExecutionKernelService(),
      capabilities as never,
      repository as never,
    );
    await second.execute(sessionId, operation("second", `${origin}/final`));
    await second.onModuleDestroy();

    const secondRuntimeObservation = observations.filter(
      (observation) => observation.operationId === "second",
    )[0];
    expect(secondRuntimeObservation?.url).toBe(`${origin}/details`);
    expect(observations.at(-1)).toEqual({ operationId: "second", url: `${origin}/final` });
    expect(repository.claimRuntimeLease).toHaveBeenCalledTimes(2);
    expect(repository.releaseRuntimeLease).toHaveBeenCalledTimes(2);
    vi.unstubAllEnvs();
  }, 30_000);
});

function capabilityFactory() {
  return {
    createSession(input: { mode: "observe" | "rehearse"; correlationId: string; options: object }) {
      const manifest = createExecutionCapabilityManifest({
        mode: input.mode,
        correlationId: input.correlationId,
        states: {
          browser: "available",
          praxis: "available",
          veil: "available",
          evidence: "available",
          journal: "available",
          protected_operations: "available",
          checkpoint: "available",
          calibration: "available",
        },
      });
      return {
        manifest,
        options: input.options,
        journal: {
          begin: vi.fn(),
          complete: vi.fn(),
          fail: vi.fn(),
          settle: vi.fn(),
        },
        mutationFence: {
          claim: vi.fn(async () => ({ state: "claimed", fencingToken: 1 })),
          transition: vi.fn(async () => true),
        },
      };
    },
    request(input: Record<string, unknown> & { capabilities: { manifest: { digest: string } } }) {
      const { capabilities, ...request } = input;
      return { ...request, capabilityManifestDigest: capabilities.manifest.digest };
    },
  };
}

function policy(origin: string) {
  return {
    allowedOrigins: [origin],
    allowPrivateNetwork: true,
    allowDownloads: false as const,
    allowPopups: false as const,
    maxActions: 20,
    maxDurationMs: 30_000,
    maxNavigations: 10,
  };
}

function operation(operationId: string, url: string) {
  return {
    operationId,
    idempotencyKey: `adaptive-${operationId}`,
    action: { type: "navigate" as const, url, timeoutMs: 10_000 },
    expectedEffect: { type: "navigation" as const, url, match: "exact" as const },
    mode: "rehearse" as const,
    protectedInputReferences: [],
  };
}
