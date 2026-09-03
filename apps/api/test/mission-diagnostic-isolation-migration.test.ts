import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const apiRoot = new URL("../", import.meta.url);
const migrationName = "mission-diagnostic-isolation.sql";

describe("Mission diagnostic isolation migration", () => {
  it("adds immutable purpose and append-only same-Project factual relations", async () => {
    const migration = await readFile(new URL(`migrations/${migrationName}`, apiRoot), "utf8");
    expect(migration).toContain("purpose text NOT NULL DEFAULT 'primary'");
    expect(migration).toContain("CHECK(purpose IN ('primary','diagnostic','recovery'))");
    expect(migration).toContain("Mission purpose is immutable");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS mission_relations");
    expect(migration).toContain("REFERENCES missions(id,project_id)");
    expect(migration).toContain("REFERENCES agent_sessions(id,mission_id)");
    expect(migration).toContain("CHECK(source_mission_id<>target_mission_id)");
    expect(migration).toContain("mission_relations_immutable");
    expect(migration).not.toMatch(/protected_operation_id|UPDATE\s+protected_operations/i);
  });

  it("participates in the baseline, guarded migrator, and both fingerprint commands", async () => {
    const [baseline, migrate, fingerprint, verify] = await Promise.all([
      readFile(new URL("migrations/baseline.sql", apiRoot), "utf8"),
      readFile(new URL("scripts/migrate.ts", apiRoot), "utf8"),
      readFile(new URL("../../../scripts/schema-fingerprint.mjs", import.meta.url), "utf8"),
      readFile(new URL("../../../scripts/verify-release-fingerprint.mjs", import.meta.url), "utf8"),
    ]);
    expect(baseline).toContain(`\\ir ${migrationName}`);
    expect(migrate).toContain("preMissionDiagnosticIsolationFingerprint");
    expect(migrate).toContain("scry-mission-diagnostic-isolation");
    expect(fingerprint).toContain(migrationName);
    expect(verify).toContain(migrationName);
  });
});
