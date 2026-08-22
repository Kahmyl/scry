import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("protected transaction runtime ownership seam", () => {
  it("requires protected transaction execution from runtime composition", async () => {
    const source = await readFile(new URL("../src/executor.ts", import.meta.url), "utf8");

    expect(source).toContain("options.protectedTransactionExecutor");

    expect(source).toContain("Protected transaction runtime capability is unavailable");

    expect(source).toContain("await options.protectedTransactionExecutor({");

    expect(source).not.toContain("executeProtectedTransactionCompatibility");

    expect(source).not.toContain("new ProtectedTransactionCoordinator");

    expect(source).not.toContain("new ProtectedTransactionKernel");
  });
});
