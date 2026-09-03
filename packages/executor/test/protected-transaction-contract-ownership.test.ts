import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("protected transaction contract ownership", () => {
  it("keeps durable operation contracts in @scry/contracts", async () => {
    const contracts = await readFile(
      new URL("../../contracts/src/protected-operation.ts", import.meta.url),
      "utf8",
    );

    const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

    const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

    expect(contracts).toContain("export type ProtectedOperationClaim");

    expect(contracts).toContain("export type ProtectedTransactionStore");

    expect(types).not.toContain("protected-transaction-coordinator");

    expect(index).not.toContain("./protected-transaction-coordinator.js");
  });
});
