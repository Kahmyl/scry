import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Milestone 4 reconciliation lease migration", () => {
  it("adds a bounded owner deadline without reinterpreting mutation history", async () => {
    const root = new URL("../", import.meta.url);
    const migration = await readFile(
      new URL("migrations/system-correctness-m4-reconciliation-lease.sql", root),
      "utf8",
    );
    const baseline = await readFile(new URL("migrations/baseline.sql", root), "utf8");
    expect(migration).toContain("lease_expires_at timestamptz");
    expect(migration).toContain("NOT NULL DEFAULT now()");
    expect(migration).not.toMatch(/UPDATE\s+adaptive_operations|mutation_outcome\s*=/i);
    expect(baseline).toContain("\\ir system-correctness-m4-reconciliation-lease.sql");
  });
});
