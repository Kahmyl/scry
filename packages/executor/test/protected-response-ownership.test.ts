import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("protected response ownership", () => {
  it("is owned by Praxis rather than Executor", async () => {
    await expect(
      access(new URL("../src/protected-response-envelope.ts", import.meta.url)),
    ).rejects.toThrow();

    const executorIndex = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

    expect(executorIndex).not.toContain("protected-response-envelope");
  });

  it("is publicly exposed by Praxis", async () => {
    const praxisIndex = await readFile(
      new URL("../../praxis/src/index.ts", import.meta.url),
      "utf8",
    );

    expect(praxisIndex).toContain('export * from "./observation/protected-response-envelope.js";');
  });
});
