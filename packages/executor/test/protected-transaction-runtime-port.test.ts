import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("protected transaction runtime port", () => {
  it("is independent of protected transaction orchestration", async () => {
    const runtime = await readFile(
      new URL("../src/protected-transaction-runtime.ts", import.meta.url),
      "utf8",
    );

    const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

    expect(runtime).toContain("export type CapsuleFactory");

    expect(runtime).toContain("export type ProtectedTransactionDependencies");

    expect(runtime).toContain("export type ProtectedTransactionExecution");

    expect(runtime).toContain("export type ProtectedTransactionExecutor");

    expect(runtime).not.toContain("protected-transaction-coordinator");

    expect(index).not.toContain("./protected-transaction-coordinator.js");
  });
});
