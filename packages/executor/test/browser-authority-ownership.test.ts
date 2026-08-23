import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Executor browser authority ownership", () => {
  it("does not own browser policy or protected capsule mechanics", async () => {
    await expect(
      access(new URL("../src/execution-browser-policy.ts", import.meta.url)),
    ).rejects.toThrow();

    await expect(
      access(new URL("../src/protected-capsule-factory.ts", import.meta.url)),
    ).rejects.toThrow();

    const praxisIndex = await readFile(
      new URL("../../praxis/src/index.ts", import.meta.url),
      "utf8",
    );

    expect(praxisIndex).toContain('export * from "./lifecycle/execution-browser-policy.js";');

    expect(praxisIndex).toContain('export * from "./lifecycle/protected-capsule-factory.js";');
  });
});
