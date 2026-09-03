import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBrowserV2SchemaManifest } from "../src/browser-execution/browser-v2-schema-manifest.js";

const migrationUrl = new URL(
  "../migrations-v2/0001-browser-execution-v2-baseline.sql",
  import.meta.url,
);
const contentAwareMigrationUrl = new URL(
  "../migrations-v2/0002-content-aware-response-capture.sql",
  import.meta.url,
);
const checkpointMigrationUrl = new URL(
  "../migrations-v2/0003-encrypted-browser-session-checkpoints.sql",
  import.meta.url,
);
const protectionAuthorityMigrationUrl = new URL(
  "../migrations-v2/0004-single-protection-authority.sql",
  import.meta.url,
);
const capturedPathReleaseMigrationUrl = new URL(
  "../migrations-v2/0005-environment-disclosure-admission.sql",
  import.meta.url,
);
const durableResponseLifecycleMigrationUrl = new URL(
  "../migrations-v2/0006-durable-response-lifecycle.sql",
  import.meta.url,
);
const keyCustodyMigrationUrl = new URL(
  "../migrations-v2/0007-versioned-key-custody.sql",
  import.meta.url,
);
const cutoverIntegrityMigrationUrl = new URL(
  "../migrations-v2/0008-production-cutover-integrity.sql",
  import.meta.url,
);

describe("browser execution v2 fresh schema", () => {
  it("uses the active migration manifest for the release schema fingerprint", async () => {
    const script = fileURLToPath(
      new URL("../../../scripts/schema-fingerprint.mjs", import.meta.url),
    );
    const releaseFingerprint = execFileSync(process.execPath, [script], {
      encoding: "utf8",
    }).trim();
    const manifest = await loadBrowserV2SchemaManifest();

    expect(releaseFingerprint).toBe(manifest.schemaFingerprint);
  });

  it("is isolated from the historical migration path and defines the complete v2 ownership chain", async () => {
    const [migration, historicalRunner, v2RootModule, v2ExecutionModule] = await Promise.all([
      readFile(migrationUrl, "utf8"),
      readFile(new URL("../scripts/migrate.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/browser-v2-app.module.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../src/browser-execution/browser-execution.module.ts", import.meta.url),
        "utf8",
      ),
    ]);
    const v2DirectImportSources = (
      await Promise.all(
        [
          "../src/browser-v2-worker.ts",
          "../src/browser-execution/browser-command.repository.ts",
          "../src/browser-execution/browser-execution-queue.service.ts",
          "../src/browser-execution/browser-execution.repository.ts",
          "../src/browser-execution/browser-lifecycle.controller.ts",
          "../src/browser-execution/browser-lifecycle.repository.ts",
        ].map((source) => readFile(new URL(source, import.meta.url), "utf8")),
      )
    ).join("\n");
    expect(historicalRunner).not.toContain("migrations-v2");
    expect(v2RootModule).not.toContain("AuthModule");
    expect(v2RootModule).not.toContain("InfrastructureModule");
    expect(v2ExecutionModule).not.toContain("InfrastructureModule");
    expect(v2RootModule).toContain("McpTokensController");
    expect(`${v2ExecutionModule}\n${v2DirectImportSources}`).not.toContain(
      "infrastructure/index.js",
    );
    expect(v2DirectImportSources).not.toContain("auth/index.js");
    expect(v2DirectImportSources).toContain("BROWSER_V2_VIDEO_RENDERING_REQUIRED");
    for (const table of [
      "app_users",
      "workspaces",
      "workspace_memberships",
      "mcp_access_tokens",
      "projects",
      "missions",
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
      "mission_reports",
    ])
      expect(migration).toContain(`CREATE TABLE ${table}`);
    expect(migration).not.toContain("protected_operations");
    expect(migration).not.toContain("operation_contract");
    expect(migration).not.toContain("prepared_execution");
  });

  it("keeps effect phases separate and rejects impossible publication and capture states", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("admission_state text");
    expect(migration).toContain("dispatch_state text");
    expect(migration).toContain("capture_state text");
    expect(migration).toContain("publication_state text");
    expect(migration).toContain("mutation_outcome text");
    expect(migration).toContain("publication_state <> 'published' OR capture_state='durable'");
    expect(migration).toContain("capture_state <> 'durable' OR dispatch_state='acknowledged'");
    expect(migration).toContain("mutation_outcome <> 'applied' OR dispatch_state='acknowledged'");
    expect(migration).toContain("'publish_capture','discard_capture','determine'");
    expect(migration).toContain("'published','discarded','applied'");
  });

  it("requires a Run to belong to exactly one Flow revision inside the same Mission", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("flow_id uuid NOT NULL");
    expect(migration).toContain("flow_revision_id uuid NOT NULL");
    expect(migration).toContain("REFERENCES flow_revisions(id,flow_id,mission_id,project_id)");
  });

  it("admits bounded JSON, text, empty and binary response evidence", async () => {
    const migration = await readFile(contentAwareMigrationUrl, "utf8");
    for (const contentClass of ["http_json", "http_text", "http_empty", "http_binary"])
      expect(migration).toContain(`'${contentClass}'`);
    expect(migration).toContain("byte_size BETWEEN 0 AND 524288");
  });

  it("stores only encrypted, fenced browser checkpoints with bounded size", async () => {
    const migration = await readFile(checkpointMigrationUrl, "utf8");
    expect(migration).toContain("CREATE TABLE browser_session_checkpoints");
    expect(migration).toContain("ciphertext bytea NOT NULL");
    expect(migration).toContain("authentication_tag bytea NOT NULL");
    expect(migration).toContain("byte_size BETWEEN 2 AND 2097152");
    expect(migration).toContain("REFERENCES browser_owner_generations(session_id,generation)");
    expect(migration).toContain("runtime_capability_version='browser-runtime-v2.3'");
    expect(migration).not.toContain("resume_url text");
  });

  it("stores one scope-bound protection decision for every published capture field", async () => {
    const migration = await readFile(protectionAuthorityMigrationUrl, "utf8");
    expect(migration).toContain("disclosure_mode text NOT NULL");
    expect(migration).toContain("CREATE TABLE browser_protection_decisions");
    expect(migration).toContain("decision_revision bigint NOT NULL");
    expect(migration).toContain("field_path jsonb NOT NULL");
    expect(migration).toContain("allowed_sinks jsonb NOT NULL");
    expect(migration).toContain("decision_set_digest text NOT NULL");
  });

  it("uses a generic environment disclosure admission mode under v2.4", async () => {
    const [authority, migration] = await Promise.all([
      readFile(protectionAuthorityMigrationUrl, "utf8"),
      readFile(capturedPathReleaseMigrationUrl, "utf8"),
    ]);
    expect(authority).toContain("trusted_application_output");
    expect(authority).toContain("public_evidence_digest");
    expect(migration).not.toContain("browser_public_release_authorizations");
    expect(migration).not.toContain("browser_run_release_authorizations");
  });

  it("atomically acknowledges responses with database-durable encrypted capture under v2.5", async () => {
    const migration = await readFile(durableResponseLifecycleMigrationUrl, "utf8");
    expect(migration).toContain("runtime_capability_version='browser-runtime-v2.5'");
    expect(migration).toContain("encrypted_payload bytea");
    expect(migration).toContain("browser_captures_durable_payload_v25");
    expect(migration).toContain("recovery_fence bigint");
  });

  it("pins versioned key custody and durable cutover receipts", async () => {
    const migration = await readFile(keyCustodyMigrationUrl, "utf8");
    expect(migration).toContain("browser-runtime-v2.6");
    expect(migration).toContain("protection_key_version");
    expect(migration).toContain("CREATE TABLE identity_import_receipts");
  });

  it("enforces scope ownership and activation integrity under v2.7", async () => {
    const migration = await readFile(cutoverIntegrityMigrationUrl, "utf8");
    expect(migration).toContain("browser-runtime-v2.7");
    expect(migration).toContain("browser_commands_session_run_v27_fk");
    expect(migration).toContain("browser_evidence_streams_session_run_v27_fk");
    expect(migration).toContain("browser_session_protected_inputs_session_project_v27_fk");
    expect(migration).toContain("browser_session_protected_inputs_value_project_v27_fk");
    expect(migration).toContain("missions_final_report_v27_fk");
    expect(migration).toContain("catalog_fingerprint");
    expect(migration).toContain("identity_import_receipts_activation_state_v27");
  });
});
