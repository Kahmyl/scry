import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AUTHORITATIVE_D647_SHAPE_SQL,
  calculateHistoricalFingerprints,
  assertAuthoritativeD647Shape,
  assertConfiguredMigrationFingerprint,
  assertReleasedFingerprintReconstruction,
  compatibilityBaseline,
  expandBaselineStage,
  HISTORICAL_BASELINE_STAGES,
  OPTIONAL_BASELINE_MIGRATIONS,
  RELEASED_HISTORICAL_FINGERPRINTS,
  SUPPORTED_HISTORICAL_BASELINES,
  supportedHistoricalFingerprints,
} from "../scripts/migration-fingerprint-compatibility.js";

describe("migration fingerprint compatibility", () => {
  it("probes an incomplete authoritative predecessor without PostgreSQL casts that can escape the stable refusal", () => {
    expect(AUTHORITATIVE_D647_SHAPE_SQL).toContain(
      "to_regclass('public.artifact_timeline_entries')",
    );
    expect(AUTHORITATIVE_D647_SHAPE_SQL).toContain(
      "to_regprocedure('public.adaptive_operation_unknown_unresolved(uuid,text)')",
    );
    expect(AUTHORITATIVE_D647_SHAPE_SQL).toContain(
      "to_regprocedure('public.protect_adaptive_operation_identity()')",
    );
    expect(AUTHORITATIVE_D647_SHAPE_SQL).not.toMatch(/'[^']+'::reg(?:class|procedure)/);
  });

  it("admits only the authoritative d647 structural predecessor", () => {
    const authoritative = {
      hasProtectedOperations: true,
      hasAdaptiveOperations: true,
      hasReconciliations: true,
      hasRecordingSelections: false,
      hasDocumentTransitionGap: false,
      hasScopedUnknownFence: false,
      hasAppliedRecoveryProjection: false,
    };

    expect(() => assertAuthoritativeD647Shape(authoritative)).not.toThrow();
    expect(() =>
      assertAuthoritativeD647Shape({ ...authoritative, hasRecordingSelections: true }),
    ).toThrow("AUTHORITATIVE_D647_LINEAGE_SHAPE_MISMATCH");
    expect(() =>
      assertAuthoritativeD647Shape({ ...authoritative, hasProtectedOperations: false }),
    ).toThrow("AUTHORITATIVE_D647_LINEAGE_SHAPE_MISMATCH");
  });

  it("refuses a configured deployment fingerprint that differs from the image migration source", () => {
    const embedded = "a".repeat(64);
    expect(() => assertConfiguredMigrationFingerprint(undefined, embedded)).not.toThrow();
    expect(() => assertConfiguredMigrationFingerprint(embedded, embedded)).not.toThrow();
    expect(() => assertConfiguredMigrationFingerprint("b".repeat(64), embedded)).toThrow(
      "MIGRATION_IMAGE_SCHEMA_FINGERPRINT_MISMATCH",
    );
  });
  it("removes every migration newer than each historical baseline", async () => {
    const baseline = await readFile(
      fileURLToPath(new URL("../migrations/baseline.sql", import.meta.url)),
      "utf8",
    );
    const historical = compatibilityBaseline(baseline);
    expect(historical).not.toContain("\\ir praxis-candidate-inspection.sql");
    expect(historical).not.toContain("\\ir authentication-authoring.sql");
    expect(historical).not.toContain("\\ir adaptive-authoring-pr9-pr12.sql");
    expect(historical).not.toContain("\\ir adaptive-execution-foundation-m0-m1.sql");
    expect(historical).not.toContain("\\ir adaptive-operation-reconciliation.sql");
  });

  it("reconstructs the immutable released fingerprints from the real migration sources", async () => {
    const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
    const source = await readFile(`${migrationDirectory}baseline.sql`, "utf8");
    const migrationSources = Object.fromEntries(
      await Promise.all(
        OPTIONAL_BASELINE_MIGRATIONS.map(async (name) => [
          name,
          await readFile(`${migrationDirectory}${name}`, "utf8"),
        ]),
      ),
    ) as Record<(typeof OPTIONAL_BASELINE_MIGRATIONS)[number], string>;
    const calibration = await readFile(`${migrationDirectory}calibration-foundation.sql`, "utf8");
    const protectedCapsule = await readFile(`${migrationDirectory}protected-capsule.sql`, "utf8");
    const fingerprints = calculateHistoricalFingerprints({
      baselineSource: source,
      migrationSources,
      expandFoundation: (value) =>
        value
          .replace("\\ir calibration-foundation.sql", () => calibration)
          .replace("\\ir protected-capsule.sql", () => protectedCapsule),
      previousVeilFullFingerprint: RELEASED_HISTORICAL_FINGERPRINTS.previous_veil_full,
    });

    expect(fingerprints).toEqual(RELEASED_HISTORICAL_FINGERPRINTS);
    expect(() => assertReleasedFingerprintReconstruction(fingerprints)).not.toThrow();
    expect(supportedHistoricalFingerprints(fingerprints)).toHaveLength(
      SUPPORTED_HISTORICAL_BASELINES.length,
    );
  }, 15_000);

  it("preserves the immediately previous full baseline as the targeted-region upgrade source", async () => {
    const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
    const source = await readFile(`${migrationDirectory}baseline.sql`, "utf8");
    const migrationSources = Object.fromEntries(
      await Promise.all(
        OPTIONAL_BASELINE_MIGRATIONS.map(async (name) => [
          name,
          await readFile(`${migrationDirectory}${name}`, "utf8"),
        ]),
      ),
    ) as Record<(typeof OPTIONAL_BASELINE_MIGRATIONS)[number], string>;
    const calibration = await readFile(`${migrationDirectory}calibration-foundation.sql`, "utf8");
    const protectedCapsule = await readFile(`${migrationDirectory}protected-capsule.sql`, "utf8");
    const previous = expandBaselineStage(
      source,
      migrationSources,
      OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "targeted-region-perception.sql"),
    )
      .replace("\\ir calibration-foundation.sql", () => calibration)
      .replace("\\ir protected-capsule.sql", () => protectedCapsule);

    expect(createHash("sha256").update(previous).digest("hex")).toBe(
      "f476a450a4d8aedb47e6ba1b7a30ad91790390e0199445d9ed5502ea7ef63ec1",
    );
  });

  it("requires one valid, distinct fingerprint for every supported historical baseline", () => {
    const values = Object.fromEntries(
      SUPPORTED_HISTORICAL_BASELINES.map((name) => [
        name,
        createHash("sha256").update(name).digest("hex"),
      ]),
    ) as Record<(typeof SUPPORTED_HISTORICAL_BASELINES)[number], string>;
    expect(supportedHistoricalFingerprints(values)).toHaveLength(
      SUPPORTED_HISTORICAL_BASELINES.length,
    );
    for (const name of SUPPORTED_HISTORICAL_BASELINES) {
      expect(values[name]).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("expands SQL containing replacement metacharacters literally", () => {
    const sources = Object.fromEntries(
      OPTIONAL_BASELINE_MIGRATIONS.map((name) => [name, ""]),
    ) as Record<(typeof OPTIONAL_BASELINE_MIGRATIONS)[number], string>;
    sources["adaptive-execution-foundation-m0-m1.sql"] = "SELECT '$&', '$`', \"$'\";";

    expect(
      expandBaselineStage("\\ir adaptive-execution-foundation-m0-m1.sql\n", sources, [
        "adaptive-execution-foundation-m0-m1.sql",
      ]),
    ).toBe("SELECT '$&', '$`', \"$'\";");
  });

  it("rejects missing, malformed, or duplicate historical fingerprints", () => {
    const duplicate = "a".repeat(64);
    const values = Object.fromEntries(
      SUPPORTED_HISTORICAL_BASELINES.map((name) => [name, duplicate]),
    ) as Record<(typeof SUPPORTED_HISTORICAL_BASELINES)[number], string>;
    expect(() => supportedHistoricalFingerprints(values)).toThrow(
      "HISTORICAL_MIGRATION_FINGERPRINT_DUPLICATE",
    );
    expect(() => supportedHistoricalFingerprints({ ...values, base: "invalid" })).toThrow(
      "HISTORICAL_MIGRATION_FINGERPRINT_INVALID",
    );
  });
});
