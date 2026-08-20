import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../migrations/20260820-0910_scope_unknown_fence_to_resource_mutations.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("adaptive unknown mission fence", () => {
  it("participates in the canonical baseline and migration runner", () => {
    const baseline = readFileSync(new URL("../migrations/baseline.sql", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../scripts/migrate.ts", import.meta.url), "utf8");

    expect(baseline).toContain("\\ir 20260820-0910_scope_unknown_fence_to_resource_mutations.sql");
    expect(runner).toContain("scopeUnknownFenceToResourceMutations");
  });

  it("preserves unknown truth while excluding preparatory authentication from the resource-mutation fence", () => {
    expect(migration).toContain("operation.authoring_intent->'action'->>'kind' <> 'authenticate'");
    expect(migration).toContain("reconciliation.result IN ('proven_applied','proven_not_applied')");
    expect(migration).not.toContain("mutation_outcome='not_applied'");
  });
});
