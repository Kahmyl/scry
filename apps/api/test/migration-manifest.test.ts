import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("schema migration manifest", () => {
  it("includes Veil migrations before the compiled-plan cutover", async () => {
    const baseline = await readFile(new URL("migrations/baseline.sql", root), "utf8");

    const preferences = baseline.indexOf("\\ir veil-observation-preferences.sql");
    const retention = baseline.indexOf("\\ir veil-artifact-retention.sql");
    const compiledPlan = baseline.indexOf("\\ir compiled-plan-cutover.sql");

    expect(preferences).toBeGreaterThan(-1);
    expect(retention).toBeGreaterThan(preferences);
    expect(compiledPlan).toBeGreaterThan(retention);
  });

  it("recognizes the previous full schema and applies the guarded compiled-plan cutover", async () => {
    const migrate = await readFile(new URL("scripts/migrate.ts", root), "utf8");

    expect(migrate).toContain("veilFullFingerprint");
    expect(migrate).toContain("previousVeilFullFingerprint");
    expect(migrate).toContain("supportedPreviousFingerprints");
    expect(migrate).toContain("await client.query(compiledPlanCutover)");
    expect(migrate).toContain("scry-compiled-plan-cutover");
  });

  it("includes every schema migration in both fingerprint commands", async () => {
    for (const path of [
      "../../../scripts/schema-fingerprint.mjs",
      "../../../scripts/verify-release-fingerprint.mjs",
    ]) {
      const source = await readFile(new URL(path, import.meta.url), "utf8");

      expect(source).toContain("veil-observation-preferences.sql");
      expect(source).toContain("veil-artifact-retention.sql");
      expect(source).toContain("compiled-plan-cutover.sql");
    }
  });

  it("keeps the retention upgrade repeat-safe", async () => {
    const retention = await readFile(
      new URL("migrations/veil-artifact-retention.sql", root),
      "utf8",
    );

    expect(retention.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(6);
    expect(retention).toContain("CREATE INDEX IF NOT EXISTS artifacts_retention_due_idx");
  });

  it("backfills compiled plans before enforcing the non-null constraint", async () => {
    const cutover = await readFile(new URL("migrations/compiled-plan-cutover.sql", root), "utf8");

    const addColumn = cutover.indexOf("ADD COLUMN IF NOT EXISTS compiled_plan jsonb");
    const backfill = cutover.indexOf("SET compiled_plan = d.plan");
    const setNotNull = cutover.indexOf("ALTER COLUMN compiled_plan SET NOT NULL");

    expect(addColumn).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(addColumn);
    expect(setNotNull).toBeGreaterThan(backfill);
  });
});
