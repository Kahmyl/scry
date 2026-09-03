import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const apiRoot = new URL("../", import.meta.url);
const migrationName = "flow-name-identity-cutover.sql";

describe("Flow name identity cutover", () => {
  it("removes label uniqueness while preserving indexed Project lookup", async () => {
    const migration = await readFile(new URL(`migrations/${migrationName}`, apiRoot), "utf8");

    expect(migration).toContain("DROP CONSTRAINT IF EXISTS flows_project_id_name_key");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS flows_project_name_idx");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
  });

  it("participates in the clean baseline, migration runner, and release fingerprint", async () => {
    const [baseline, migrate, fingerprint, releaseFingerprint] = await Promise.all([
      readFile(new URL("migrations/baseline.sql", apiRoot), "utf8"),
      readFile(new URL("scripts/migrate.ts", apiRoot), "utf8"),
      readFile(new URL("../../../scripts/schema-fingerprint.mjs", import.meta.url), "utf8"),
      readFile(new URL("../../../scripts/verify-release-fingerprint.mjs", import.meta.url), "utf8"),
    ]);

    expect(baseline).toContain(`\\ir ${migrationName}`);
    expect(migrate).toContain(migrationName);
    expect(migrate).toContain("preFlowNameIdentityCutoverFingerprint");
    expect(fingerprint).toContain(migrationName);
    expect(releaseFingerprint).toContain(migrationName);
  });
});
