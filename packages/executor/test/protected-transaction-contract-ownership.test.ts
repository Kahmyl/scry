import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("protected transaction contract ownership", () => {
  it("keeps durable operation contracts in @scry/contracts", async () => {
    const coordinator = await readFile(
      new URL("../src/protected-transaction-coordinator.ts", import.meta.url),
      "utf8",
    );

    const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

    expect(coordinator).toContain(
      'export type { ProtectedOperationClaim, ProtectedTransactionStore } from "@scry/contracts"',
    );

    expect(coordinator).not.toContain("export type ProtectedOperationClaim = {");

    expect(coordinator).not.toContain("export type ProtectedTransactionStore = {");

    expect(types).toContain("protectedTransactionStore?: ProtectedTransactionStore");

    expect(types).not.toContain(
      'import("./protected-transaction-coordinator.js").ProtectedOperationClaim',
    );

    expect(types).not.toContain(
      'import("./protected-transaction-coordinator.js").ProtectedTransactionStore',
    );
  });
});
