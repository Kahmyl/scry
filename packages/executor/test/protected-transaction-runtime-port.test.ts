import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("protected transaction runtime port", () => {
  it("separates public runtime types from coordinator implementation", async () => {
    const runtime = await readFile(
      new URL("../src/protected-transaction-runtime.ts", import.meta.url),
      "utf8",
    );

    const coordinator = await readFile(
      new URL("../src/protected-transaction-coordinator.ts", import.meta.url),
      "utf8",
    );

    const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

    const executor = await readFile(new URL("../src/executor.ts", import.meta.url), "utf8");

    expect(runtime).toContain("export type CapsuleFactory");

    expect(runtime).toContain("export type ProtectedTransactionDependencies");

    expect(runtime).toContain("export type ProtectedTransactionExecution");

    expect(runtime).toContain("export type ProtectedTransactionExecutor");

    expect(coordinator).not.toContain("export type ProtectedTransactionDependencies =");

    expect(coordinator).not.toContain("export type ProtectedTransactionExecution =");

    expect(types).not.toContain("protected-transaction-coordinator");

    expect(executor).toContain('from "./protected-transaction-runtime.js"');

    // Facts and helper-internal types intentionally remain
    // with the implementation cluster in this cut.
    expect(coordinator).toContain("ProtectedTransactionFacts");
  });
});

describe("protected transaction runtime port independence", () => {
  it("runtime port has no coordinator implementation dependency", async () => {
    const runtime = await readFile(
      new URL("../src/protected-transaction-runtime.ts", import.meta.url),
      "utf8",
    );

    expect(runtime).not.toContain("protected-transaction-coordinator");
  });
});
