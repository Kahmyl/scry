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
    const interactiveCommands = baseline.indexOf("\\ir interactive-runtime-commands.sql");
    const interactiveLifecycle = baseline.indexOf("\\ir interactive-runtime-lifecycle.sql");
    const authenticationAuthoring = baseline.indexOf("\\ir authentication-authoring.sql");
    const missionFirstM1 = baseline.indexOf("\\ir mission-first-live-convergence-m1.sql");
    const missionAuthoringM2 = baseline.indexOf("\\ir mission-authoring-grouped-turns-m2.sql");
    const protectedStateMachine = baseline.indexOf("\\ir protected-operation-state-machine.sql");
    const protectedCompletion = baseline.indexOf("\\ir protected-operation-completion.sql");
    const protectedProjection = baseline.indexOf(
      "\\ir protected-operation-authoritative-projection.sql",
    );
    const protectedResponseStaging = baseline.indexOf("\\ir protected-response-output-staging.sql");
    const protectedReadOnlyDispatch = baseline.indexOf("\\ir protected-read-only-dispatch.sql");
    const externalResourceBindings = baseline.indexOf("\\ir external-resource-bindings.sql");

    expect(preferences).toBeGreaterThan(-1);
    expect(retention).toBeGreaterThan(preferences);
    expect(compiledPlan).toBeGreaterThan(retention);
    expect(statefulProbe).toBeGreaterThan(compiledPlan);
    expect(interactiveCommands).toBeGreaterThan(statefulProbe);
    expect(interactiveLifecycle).toBeGreaterThan(interactiveCommands);
    expect(authenticationAuthoring).toBeGreaterThan(interactiveLifecycle);
    expect(missionFirstM1).toBeGreaterThan(authenticationAuthoring);
    expect(missionAuthoringM2).toBeGreaterThan(missionFirstM1);
    expect(protectedStateMachine).toBeGreaterThan(missionAuthoringM2);
    expect(protectedCompletion).toBeGreaterThan(protectedStateMachine);
    expect(protectedProjection).toBeGreaterThan(protectedCompletion);
    expect(protectedResponseStaging).toBeGreaterThan(protectedProjection);
    expect(protectedReadOnlyDispatch).toBeGreaterThan(protectedResponseStaging);
    expect(externalResourceBindings).toBeGreaterThan(protectedReadOnlyDispatch);
  });

  it("recognizes the compiled-plan schema and applies the guarded interactive command cutover", async () => {
    const migrate = await readFile(new URL("scripts/migrate.ts", root), "utf8");

    expect(migrate).toContain("releasedHistoricalFingerprints.compiled_plan");
    expect(migrate).toContain("releasedHistoricalFingerprints.stateful_probe_authoring");
    expect(migrate).toContain("supportedPreviousFingerprints");
    expect(migrate).toContain("deployedAdaptiveAuthoringFingerprint");
    expect(migrate).toContain("await client.query(interactiveRuntimeCommands)");
    expect(migrate).toContain("await client.query(interactiveRuntimeLifecycle)");
    expect(migrate).toContain("releasedHistoricalFingerprints.interactive_runtime_commands");
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
      expect(source).toContain("operational-events.sql");
      expect(source).toContain("mission-diagnostic-isolation.sql");
      expect(source).toContain("compiled-plan-cutover.sql");
      expect(source).toContain("stateful-probe-authoring.sql");
      expect(source).toContain("interactive-runtime-commands.sql");
      expect(source).toContain("interactive-runtime-lifecycle.sql");
      expect(source).toContain("praxis-candidate-inspection.sql");
      expect(source).toContain("authentication-authoring.sql");
      expect(source).toContain("adaptive-authoring-pr9-pr12.sql");
      expect(source).toContain("adaptive-execution-foundation-m0-m1.sql");
      expect(source).toContain("adaptive-sessions-m3.sql");
      expect(source).toContain("mission-first-live-convergence-m1.sql");
      expect(source).toContain("mission-authoring-grouped-turns-m2.sql");
      expect(source).toContain("protected-operation-state-machine.sql");
      expect(source).toContain("protected-operation-completion.sql");
      expect(source).toContain("protected-operation-authoritative-projection.sql");
      expect(source).toContain("protected-response-output-staging.sql");
      expect(source).toContain("protected-read-only-dispatch.sql");
      expect(source).toContain("external-resource-bindings.sql");
      expect(source).toContain("segmented-flow-successor-checkpoints.sql");
      expect(source).toContain("20260820-0910_scope_unknown_fence_to_resource_mutations.sql");
    }
  });

  it("keeps terminal immutability while admitting only canonical durable protected projection", async () => {
    const migration = await readFile(
      new URL("migrations/protected-operation-authoritative-projection.sql", root),
      "utf8",
    );
    expect(migration).toContain("Adaptive operations cannot be deleted");
    expect(migration).toContain("Terminal adaptive operations are immutable");
    expect(migration).toContain("owner_kind='authoring_session'");
    expect(migration).toContain("durable_count<>1");
    expect(migration).toContain(
      "Completed adaptive protected projection disagrees with durable operation",
    );
    expect(migration).not.toContain("current_setting");
  });

  it("stores successor browser restoration material only as ciphertext and commitments", async () => {
    const migration = await readFile(
      new URL("migrations/segmented-flow-successor-checkpoints.sql", root),
      "utf8",
    );
    expect(migration).toContain("ciphertext bytea");
    expect(migration).toContain("restoration_commitment text");
    expect(migration).toContain("semantic_commitment text");
    expect(migration).not.toContain("restoration_url");
    expect(migration).not.toContain("safe_semantic_context");
    expect(migration).toContain("restore_fencing_token");
  });

  it("defines the complete Mission-first M1 ownership cutover", async () => {
    const migration = await readFile(
      new URL("migrations/mission-first-live-convergence-m1.sql", root),
      "utf8",
    );
    expect(migration).toContain("owner_mission_id uuid");
    expect(migration).toContain("owner_objective_id uuid");
    expect(migration).toContain("Legacy imported flows - ");
    expect(migration).toContain("flows_published_owner_immutable");
    expect(migration).toContain("adaptive_sessions_flow_draft_owner_fk");
    expect(migration).toContain("REFERENCES flow_drafts(id,mission_id,objective_id)");
    expect(migration.indexOf("UPDATE flows f")).toBeLessThan(
      migration.indexOf("ALTER COLUMN owner_mission_id SET NOT NULL"),
    );
  });

  it("adds an authentication attempt ledger without secret-bearing columns", async () => {
    const cutover = await readFile(
      new URL("migrations/authentication-authoring.sql", root),
      "utf8",
    );

    expect(cutover).toContain("CREATE TABLE IF NOT EXISTS authentication_attempts");
    expect(cutover).toContain("credential_reference_id uuid");
    expect(cutover).not.toMatch(/\b(password|token|clipboard)_/i);
    expect(cutover).toContain("safe_metadata::text !~*");
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

    expect(cutover).toContain("ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'queued'");
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
    expect(cutover).toContain(
      "WHERE state IN ('provisioning', 'active', 'suspended', 'releasing')",
    );
    expect(cutover).toContain("CREATE TABLE IF NOT EXISTS probe_authoring_sessions");
    expect(cutover).toContain("FOREIGN KEY (browser_lease_id, probe_session_id)");
    expect(cutover).toContain("REFERENCES authoring_browser_leases(id, probe_session_id)");
  });

  it("persists fenced interactive commands and terminal results", async () => {
    const cutover = await readFile(
      new URL("migrations/interactive-runtime-commands.sql", root),
      "utf8",
    );

    expect(cutover).toContain("CREATE TABLE IF NOT EXISTS authoring_runtime_commands");
    expect(cutover).toContain("CREATE TABLE IF NOT EXISTS authoring_runtime_command_results");
    expect(cutover).toContain("UNIQUE (probe_session_id, idempotency_key)");
    expect(cutover).toContain("claimed_by_runtime_owner_id text");
    expect(cutover).toContain("claim_token uuid UNIQUE");
    expect(cutover).toContain("REFERENCES authoring_browser_leases(id, probe_session_id)");
    expect(cutover).toContain("CHECK (outcome IN ('completed', 'failed', 'cancelled'))");
  });
  it("expands interactive command types through a forward-only migration", async () => {
    const cutover = await readFile(
      new URL("migrations/interactive-runtime-lifecycle.sql", root),
      "utf8",
    );

    expect(cutover).toContain("DROP CONSTRAINT authoring_runtime_commands_type_check");
    expect(cutover).toContain("'interact'");
    expect(cutover).toContain("'suspend'");
    expect(cutover).toContain("'resume'");
    expect(cutover).toContain("'cancel'");
  });
});
