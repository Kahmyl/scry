import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("M2 grouped Mission authoring migration", () => {
  it("qualifies M1 ownership into repeat-safe active Flow ownership", async () => {
    const migration = await readFile(
      new URL("migrations/mission-authoring-grouped-turns-m2.sql", root),
      "utf8",
    );

    expect(migration).toContain("ADD COLUMN IF NOT EXISTS active_objective_id uuid");
    expect(migration).toContain("authoring_turn_budgets jsonb");
    expect(migration).toContain("protected_reference_allowlist jsonb");
    expect(migration).toContain("SET active_objective_id=objective_id");
    expect(migration).toContain("adaptive_sessions_active_flow_owner_fk");
    expect(migration).toContain("adaptive_sessions_active_owner_required_check");
    expect(migration).toContain("FOREIGN KEY(flow_draft_id,mission_id,objective_id)");
    expect(migration).toContain("ALTER COLUMN authoring_intent SET NOT NULL");
    expect(migration).toContain("ALTER COLUMN derived_action SET NOT NULL");
    expect(migration).toContain("adaptive_operations_required_owner_check");
    expect(migration).toContain("state IN ('completed','failed') OR");
    expect(migration).not.toContain("ALTER COLUMN mission_id SET NOT NULL");
    expect(migration).toContain("LEGACY_OPERATION_UNOWNED_AT_M2_CUTOVER");
    expect(migration).toContain("AND operation.state IN ('pending','running')");
    expect(migration.match(/DROP TRIGGER IF EXISTS adaptive_operations_identity_immutable/g)).toHaveLength(2);
    expect(migration).toContain("CREATE TRIGGER adaptive_operations_identity_immutable");
    expect(migration.indexOf("DROP TRIGGER IF EXISTS adaptive_operations_identity_immutable"))
      .toBeLessThan(migration.indexOf("UPDATE adaptive_operations operation"));
  });

  it("keeps historical Flow operations valid when a session hands off to a new active Flow", async () => {
    const migration = await readFile(
      new URL("migrations/mission-authoring-grouped-turns-m2.sql", root),
      "utf8",
    );

    expect(migration).toContain("FOREIGN KEY(session_id,mission_id)\n      REFERENCES adaptive_sessions(id,mission_id)");
    expect(migration).toContain("adaptive_operations_flow_owner_fk");
    expect(migration).not.toContain("REFERENCES adaptive_sessions(id,mission_id,active_objective_id,active_flow_draft_id)");
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS adaptive_sessions_active_owner_unique");
  });

  it("creates replayable turn and same-Mission Flow handoff journals idempotently", async () => {
    const migration = await readFile(
      new URL("migrations/mission-authoring-grouped-turns-m2.sql", root),
      "utf8",
    );

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS mission_authoring_turns");
    expect(migration).toContain("UNIQUE(session_id,idempotency_key)");
    expect(migration).toContain("mission_authoring_turns_one_active_per_session_idx");
    expect(migration).toContain("WHERE state IN ('running','pending')");
    expect(migration).toContain("state='running' AND safe_response IS NULL");
    expect(migration).toContain("state='pending' AND safe_response IS NOT NULL AND current_phase IS NOT NULL AND completed_at IS NULL");
    expect(migration).toContain("state IN ('completed','decision_required','failed') AND safe_response IS NOT NULL AND completed_at IS NOT NULL");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS mission_authoring_session_flows");
    expect(migration).toContain("safe_input jsonb NOT NULL");
    expect(migration).toContain("continuation_idempotency_key text");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS mission_authoring_handoffs");
    expect(migration).toContain("FOREIGN KEY(target_flow_draft_id,mission_id,target_objective_id)");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS");
    expect(migration).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint");
  });

  it("extends journals without replacing M1 and applies M2 after M1", async () => {
    const migrate = await readFile(new URL("scripts/migrate.ts", root), "utf8");
    const compatibility = await readFile(
      new URL("scripts/migration-fingerprint-compatibility.ts", root),
      "utf8",
    );

    expect(migrate).toContain("preMissionAuthoringGroupedTurnsM2Fingerprint");
    expect(migrate).toContain("scry-mission-authoring-grouped-turns-m2");
    expect(migrate).toContain(
      "await client.query(missionFirstM1);\n        await client.query(missionAuthoringGroupedTurnsM2);",
    );
    expect(compatibility).toContain("mission-authoring-grouped-turns-m2.sql");
    expect(compatibility).toContain("RELEASED_HISTORICAL_FINGERPRINTS");
  });
});
