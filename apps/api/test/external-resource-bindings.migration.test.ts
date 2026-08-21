import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = new URL("../migrations/external-resource-bindings.sql", import.meta.url);

describe("external resource binding migration", () => {
  it("enforces scoped one-to-one identity and immutable provenance", async () => {
    const source = await readFile(migration, "utf8");
    expect(source).toContain(
      "UNIQUE(source_protected_operation_id,provider,resource_kind,resource_scope)",
    );
    expect(source).toContain("external_resource_bindings_active_identity_unique");
    expect(source).toContain(
      "project_id,environment_id,provider,resource_kind,resource_scope,canonical_external_identity",
    );
    expect(source).toContain("generated_public_value_id,source_protected_operation_id,project_id");
    expect(source).toContain("External resource binding identity is immutable");
    expect(source).toContain("External resource bindings cannot be deleted");
  });

  it("represents unavailable identity without inventing a public value", async () => {
    const source = await readFile(migration, "utf8");
    expect(source).toContain("lifecycle_state='unavailable' AND generated_public_value_id IS NULL");
    expect(source).toContain("canonical_external_identity IS NULL");
  });

  it("invalidates or desynchronizes bindings with local credential lifecycle", async () => {
    const source = await readFile(migration, "utf8");
    expect(source).toContain("AFTER UPDATE OF security_status ON project_credentials");
    expect(source).toContain("THEN 'invalidated' ELSE 'desynchronized'");
    expect(source).not.toMatch(/digest|hash.*identity/i);
  });
});
