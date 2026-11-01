import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const schemaDirectory = new URL("../baseline-schema/", import.meta.url);

describe("browser execution baseline schema", () => {
  it("defines the complete baseline ownership chain without exact schema fingerprints", async () => {
    const names = (await readdir(schemaDirectory))
      .filter((name) => /^\d{4}-.+\.sql$/u.test(name))
      .sort();
    const schema = (
      await Promise.all(names.map((name) => readFile(new URL(name, schemaDirectory), "utf8")))
    ).join("\n");

    for (const table of [
      "schema_baseline",
      "app_users",
      "workspaces",
      "workspace_memberships",
      "mcp_access_tokens",
      "projects",
      "missions",
      "agent_sessions",
      "mission_objectives",
      "environments",
      "flows",
      "flow_revisions",
      "runs",
      "browser_execution_sessions",
      "browser_execution_outbox",
      "browser_commands",
      "browser_command_outbox",
      "browser_owner_generations",
      "browser_actions",
      "browser_effects",
      "browser_effect_events",
      "browser_captures",
      "browser_publications",
      "browser_outputs",
      "protected_values",
      "browser_evidence_streams",
      "browser_evidence_chunks",
      "browser_session_checkpoints",
      "browser_protection_decisions",
      "mission_reports",
      "artifacts",
      "identity_import_receipts",
    ]) {
      expect(schema).toContain(`CREATE TABLE ${table}`);
    }

    expect(schema).not.toContain("schema_fingerprint");
    expect(schema).not.toContain("catalog_fingerprint");
    expect(schema).not.toMatch(/browser-runtime-v\d/u);
    expect(schema).toContain("runtime_capability_id='browser-execution'");
  });

  it("keeps effect phases and impossible-state guards explicit", async () => {
    const schema = await readFile(
      new URL("0001-browser-execution-baseline.sql", schemaDirectory),
      "utf8",
    );
    for (const field of [
      "admission_state text",
      "dispatch_state text",
      "capture_state text",
      "publication_state text",
      "mutation_outcome text",
    ]) {
      expect(schema).toContain(field);
    }
    expect(schema).toContain("publication_state <> 'published' OR capture_state='durable'");
    expect(schema).toContain("capture_state <> 'durable' OR dispatch_state='acknowledged'");
    expect(schema).toContain("mutation_outcome <> 'applied' OR dispatch_state='acknowledged'");
  });

  it("preserves encrypted checkpoints, protected-value custody, and evidence integrity", async () => {
    const schema = (
      await Promise.all(
        [
          "0001-browser-execution-baseline.sql",
          "0003-encrypted-browser-session-checkpoints.sql",
          "0004-single-protection-authority.sql",
          "0006-durable-response-lifecycle.sql",
          "0007-key-custody.sql",
        ].map((name) => readFile(new URL(name, schemaDirectory), "utf8")),
      )
    ).join("\n");

    expect(schema).toContain("ciphertext bytea NOT NULL");
    expect(schema).toContain("authentication_tag bytea NOT NULL");
    expect(schema).toContain("key_id text NOT NULL");
    expect(schema).toContain("previous_digest text NOT NULL");
    expect(schema).toContain("decision_set_digest text NOT NULL");
    expect(schema).toContain("encrypted_payload bytea");
  });

  it("uses capability checks that permit additive schema changes", async () => {
    const checker = await readFile(
      new URL("../src/browser-execution/browser-schema.ts", import.meta.url),
      "utf8",
    );
    expect(checker).toContain("information_schema.columns");
    expect(checker).toContain("SCRY_BROWSER_SCHEMA_INCOMPLETE");
    expect(checker).not.toContain("createHash");
    expect(checker).not.toContain("pg_indexes");
    expect(checker).not.toContain("pg_constraint");
  });

  it("provides a transactional, data-preserving bridge for retained databases", async () => {
    const [bridge, runner] = await Promise.all([
      readFile(
        new URL("../baseline-schema/compatibility/legacy-browser-generation.sql", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../scripts/baseline-migration.ts", import.meta.url), "utf8"),
    ]);
    expect(runner).toContain("runtime_capability_version");
    expect(runner).toContain("compatibilityApplied");
    expect(runner).toContain("node-pg-migrate");
    expect(bridge).toContain("RENAME COLUMN runtime_capability_version");
    expect(bridge).toContain("RENAME COLUMN protection_key_version");
    expect(bridge).toContain("RENAME COLUMN key_version TO key_id");
    expect(bridge).toContain("INSERT INTO schema_baseline(singleton,runtime_capability_id)");
    expect(bridge.indexOf("INSERT INTO schema_baseline")).toBeGreaterThan(
      bridge.indexOf("DROP COLUMN schema_version"),
    );
    expect(bridge).not.toMatch(/DELETE FROM|TRUNCATE|DROP TABLE/u);
  });
});
