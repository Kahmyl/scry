import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("schema migration manifest", () => {
  it("orders interactive runtime commands after stateful Probe authoring", async () => {
    const baseline = await readFile(new URL("migrations/baseline.sql", root), "utf8");

    const preferences = baseline.indexOf("\\ir veil-observation-preferences.sql");
    const retention = baseline.indexOf("\\ir veil-artifact-retention.sql");
    const compiledPlan = baseline.indexOf("\\ir compiled-plan-cutover.sql");
    const statefulProbe = baseline.indexOf("\\ir stateful-probe-authoring.sql");
    const interactiveCommands = baseline.indexOf(
      "\\ir interactive-runtime-commands.sql",
    );
    const interactiveLifecycle = baseline.indexOf(
      "\\ir interactive-runtime-lifecycle.sql",
    );

    expect(preferences).toBeGreaterThan(-1);
    expect(retention).toBeGreaterThan(preferences);
    expect(compiledPlan).toBeGreaterThan(retention);
    expect(statefulProbe).toBeGreaterThan(compiledPlan);
    expect(interactiveCommands).toBeGreaterThan(statefulProbe);
    expect(interactiveLifecycle).toBeGreaterThan(interactiveCommands);
  });

  it("recognizes the compiled-plan schema and applies the guarded interactive command cutover", async () => {
    const migrate = await readFile(new URL("scripts/migrate.ts", root), "utf8");

    expect(migrate).toContain("compiledPlanFingerprint");
    expect(migrate).toContain("statefulProbeAuthoringFingerprint");
    expect(migrate).toContain("supportedPreviousFingerprints");
    expect(migrate).toContain("await client.query(interactiveRuntimeCommands)");
    expect(migrate).toContain("await client.query(interactiveRuntimeLifecycle)");
    expect(migrate).toContain("interactiveRuntimeCommandsFingerprint");
    expect(migrate).toContain("scry-interactive-runtime-lifecycle-cutover");
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
      expect(source).toContain("stateful-probe-authoring.sql");
      expect(source).toContain("interactive-runtime-commands.sql");
      expect(source).toContain("interactive-runtime-lifecycle.sql");
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

  it("adds Probe mode repeat-safely while preserving queued behavior", async () => {
    const cutover = await readFile(
      new URL("migrations/stateful-probe-authoring.sql", root),
      "utf8",
    );

    expect(cutover).toContain(
      "ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'queued'",
    );
    expect(cutover).toContain("probe_sessions_mode_check");
    expect(cutover).toContain("CHECK (mode IN ('queued', 'interactive'))");
  });

  it("keeps only one live browser lease per Probe Session while retaining lease history", async () => {
    const cutover = await readFile(
      new URL("migrations/stateful-probe-authoring.sql", root),
      "utf8",
    );

    expect(cutover).toContain("CREATE TABLE IF NOT EXISTS authoring_browser_leases");
    expect(cutover).not.toContain("probe_session_id uuid NOT NULL UNIQUE");
    expect(cutover).toContain("UNIQUE (id, probe_session_id)");
    expect(cutover).toContain("authoring_browser_leases_live_probe_idx");
    expect(cutover).toContain("WHERE state IN ('provisioning', 'active', 'suspended', 'releasing')");
    expect(cutover).toContain("CREATE TABLE IF NOT EXISTS probe_authoring_sessions");
    expect(cutover).toContain("FOREIGN KEY (browser_lease_id, probe_session_id)");
    expect(cutover).toContain(
      "REFERENCES authoring_browser_leases(id, probe_session_id)",
    );
  });

  it("persists fenced interactive commands and terminal results", async () => {
    const cutover = await readFile(
      new URL("migrations/interactive-runtime-commands.sql", root),
      "utf8",
    );

    expect(cutover).toContain(
      "CREATE TABLE IF NOT EXISTS authoring_runtime_commands",
    );
    expect(cutover).toContain(
      "CREATE TABLE IF NOT EXISTS authoring_runtime_command_results",
    );
    expect(cutover).toContain("UNIQUE (probe_session_id, idempotency_key)");
    expect(cutover).toContain("claimed_by_runtime_owner_id text");
    expect(cutover).toContain("claim_token uuid UNIQUE");
    expect(cutover).toContain(
      "REFERENCES authoring_browser_leases(id, probe_session_id)",
    );
    expect(cutover).toContain(
      "CHECK (outcome IN ('completed', 'failed', 'cancelled'))",
    );
  });
  it("expands interactive command types through a forward-only migration", async () => {
    const cutover = await readFile(
      new URL("migrations/interactive-runtime-lifecycle.sql", root),
      "utf8",
    );

    expect(cutover).toContain(
      "DROP CONSTRAINT authoring_runtime_commands_type_check",
    );
    expect(cutover).toContain("'interact'");
    expect(cutover).toContain("'suspend'");
    expect(cutover).toContain("'resume'");
    expect(cutover).toContain("'cancel'");
  });

});
