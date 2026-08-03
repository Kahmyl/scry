import { describe, expect, it } from "vitest";

import { compileVeilPolicy } from "@scry/veil";
import { resolveVeilPolicyForExecution } from "../src/executor.js";

describe("executor Veil policy adapter", () => {
  it("uses an immutable supplied snapshot and rejects a forged digest", () => {
    const executionPolicy = {
      allowedOrigins: ["https://example.com"],
      allowPrivateNetwork: false,
      allowDownloads: false as const,
      allowPopups: false as const,
      maxActions: 10,
      maxDurationMs: 10_000,
      maxNavigations: 2,
    };
    const snapshot = compileVeilPolicy({
      profile: "minimal_capture",
      allowedOrigins: ["https://example.com"],
    });
    expect(resolveVeilPolicyForExecution(executionPolicy, snapshot)).toEqual(snapshot);
    expect(() =>
      resolveVeilPolicyForExecution(executionPolicy, { ...snapshot, digest: "0".repeat(64) }),
    ).toThrow("VEIL_POLICY_SNAPSHOT_DIGEST_INVALID");
  });
});
