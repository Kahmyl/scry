import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("Veil schema migration manifest", () => {
  it("includes preferences then retention in the clean baseline", async () => {
    const baseline = await readFile(new URL("migrations/baseline.sql", root), "utf8");
    const preferences = baseline.indexOf("\\ir veil-observation-preferences.sql");
    const retention = baseline.indexOf("\\ir veil-artifact-retention.sql");
    expect(preferences).toBeGreaterThan(-1);
    expect(retention).toBeGreaterThan(preferences);
  });

  it("recognizes the preferences-only fingerprint and applies guarded retention", async () => {
    const migrate = await readFile(new URL("scripts/migrate.ts", root), "utf8");
    expect(migrate).toContain("preferencesFingerprint");
    expect(migrate).toMatch(
      /preferencesFingerprint,\s*previousVeilFullFingerprint,?\s*\]\.includes\(installedFingerprint\)/,
    );
    expect(migrate).toContain("await client.query(veilArtifactRetention)");
    expect(migrate).toContain("installedFingerprint !== preferencesFingerprint");
  });

  it("includes every Veil migration in both fingerprint commands", async () => {
    for (const path of [
      "../../../scripts/schema-fingerprint.mjs",
      "../../../scripts/verify-release-fingerprint.mjs",
    ]) {
      const source = await readFile(new URL(path, import.meta.url), "utf8");
      expect(source).toContain("veil-observation-preferences.sql");
      expect(source).toContain("veil-artifact-retention.sql");
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
});
