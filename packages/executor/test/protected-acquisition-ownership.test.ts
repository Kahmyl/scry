import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("protected acquisition ownership", () => {
  it("is owned by Praxis", async () => {
    await expect(
      access(new URL("../src/protected-extractor.ts", import.meta.url)),
    ).rejects.toThrow();

    await expect(
      access(new URL("../src/privacy-clipboard-runtime.ts", import.meta.url)),
    ).rejects.toThrow();

    const praxisIndex = await readFile(
      new URL("../../praxis/src/index.ts", import.meta.url),
      "utf8",
    );

    expect(praxisIndex).toContain('export * from "./protected-acquisition.js";');

    expect(praxisIndex).toContain('export * from "./lifecycle/protected-clipboard.js";');
  });
});
