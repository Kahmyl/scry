import { describe, expect, it } from "vitest";

import {
  compileDefaultVeilPolicy,
  compileVeilPolicy,
  VeilPolicyCompilationError,
  veilPolicyDigest,
} from "../src/policy.js";

describe("compileVeilPolicy", () => {
  it("is deterministic, canonical, and deeply immutable", () => {
    const a = compileVeilPolicy({ allowedOrigins: ["https://b.example", "https://a.example"] });
    const b = compileVeilPolicy({ allowedOrigins: ["https://a.example", "https://b.example"] });
    expect(a.digest).toBe(b.digest);
    expect(a.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.controls)).toBe(true);
    expect(
      veilPolicyDigest({
        schemaVersion: a.schemaVersion,
        profile: a.profile,
        allowedOrigins: a.allowedOrigins,
        controls: a.controls,
        leaseTtlMs: a.leaseTtlMs,
      }),
    ).toBe(a.digest);
  });

  it("uses the most restrictive setting across layers", () => {
    const result = compileVeilPolicy([
      {
        profile: "balanced",
        allowedOrigins: ["https://a.example", "https://b.example"],
        controls: { video: true },
        leaseTtlMs: 10_000,
      },
      {
        profile: "private",
        allowedOrigins: ["https://b.example"],
        controls: { screenshots: false },
        leaseTtlMs: 1_000,
      },
    ]);
    expect(result.profile).toBe("private");
    expect(result.allowedOrigins).toEqual(["https://b.example"]);
    expect(result.controls.video).toBe(false);
    expect(result.controls.screenshots).toBe(false);
    expect(result.leaseTtlMs).toBe(1_000);
  });

  it("never permits custom controls to weaken the safety floor", () => {
    expect(() =>
      compileVeilPolicy({
        profile: "custom",
        allowedOrigins: ["https://a.example"],
        controls: { maskSensitiveVisuals: false } as never,
      }),
    ).toThrow();
  });

  it("rejects layers with no common origin", () => {
    expect(() =>
      compileVeilPolicy([
        { allowedOrigins: ["https://a.example"] },
        { allowedOrigins: ["https://b.example"] },
      ]),
    ).toThrow(VeilPolicyCompilationError);
  });

  it("adapts the existing execution policy without weakening it", () => {
    const result = compileDefaultVeilPolicy({
      allowedOrigins: ["https://a.example"],
      allowDownloads: false,
    });
    expect(result.profile).toBe("balanced");
    expect(result.controls.downloads).toBe(false);
    expect(result.controls.quarantineUnknown).toBe(true);
  });
});
