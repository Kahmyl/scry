import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("protected transaction runtime ownership seam", () => {
  it("delegates protected transaction execution through runtime composition", async () => {
    const source = await readFile(new URL("../src/executor.ts", import.meta.url), "utf8");

    expect(source).toMatch(
      /options\.protectedTransactionExecutor\s*\?\?\s*executeProtectedTransactionCompatibility/,
    );

    expect(source).toContain("await executeProtectedTransaction({");

    expect(source).not.toContain("new ProtectedTransactionCoordinator");
  });
});
