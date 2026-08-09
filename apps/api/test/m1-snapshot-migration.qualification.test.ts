import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("M1 real-snapshot migration qualification", () => {
  it("reconciles the actual pre-cutover snapshot idempotently", () => {
    const output = execFileSync("node", ["scripts/verify-m1-preflight.mjs", "--migration-only"], {
      cwd: new URL("../../..", import.meta.url),
      encoding: "utf8",
      env: process.env,
    });
    expect(JSON.parse(output)).toMatchObject({
      verdict: "pass",
      migration: {
        snapshotRestored: true,
        invalidOwnershipTuples: 0,
        terminalizedLegacySessions: 33,
        migrationEvidenceEvents: 33,
        encryptedVitractBindings: 2,
        idempotent: true,
      },
    });
  }, 120_000);
});
