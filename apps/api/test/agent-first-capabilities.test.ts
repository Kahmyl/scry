import { afterEach, describe, expect, it, vi } from "vitest";

import { FlowService } from "../src/flows/flow.service.js";

describe("agent-first public capabilities", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("advertises factual live-session execution without retired admission authority", () => {
    const capabilities = new FlowService({} as never, {} as never).capabilities();
    expect(capabilities.agentDirectedExecution).toEqual({
      livePraxisSession: true,
      factualObservation: true,
      exactReferenceRequired: true,
      durableRunLedger: true,
      explicitRunFinalization: true,
      automaticProgression: false,
      compileCertificationRequired: false,
      calibrationRequired: false,
    });
    expect(capabilities.adaptiveExecution).toMatchObject({ authoringTurn: false });
    expect(capabilities.adaptiveExecution.modes).not.toContain("certify");
    expect(capabilities.groundingCapabilities).not.toContain("risk-thresholds");
    expect(capabilities.groundingCapabilities).not.toContain("effect-verification");
    expect(capabilities.groundingCapabilities).not.toContain("bounded-protected-recovery");
  });

  it("reports the startup-captured source and runtime identity", () => {
    vi.stubEnv("SCRY_GIT_COMMIT", "abc123");
    vi.stubEnv("SCRY_SOURCE_DIRTY", "true");
    vi.stubEnv("SCRY_SOURCE_MANIFEST_SHA256", "f".repeat(64));
    vi.stubEnv("SCRY_RUNTIME_VERSION", "node-v24");

    expect(new FlowService({} as never, {} as never).capabilities().sourceIdentity).toEqual({
      gitCommit: "abc123",
      dirty: true,
      manifestSha256: "f".repeat(64),
      runtimeVersion: "node-v24",
    });
  });
});
