import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const snapshot = "/private/tmp/scry-m1-cutover-2b9e22e42cf3/development-db.dump";

describe.skipIf(!existsSync(snapshot))("M1 real-snapshot migration qualification", () => {
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
