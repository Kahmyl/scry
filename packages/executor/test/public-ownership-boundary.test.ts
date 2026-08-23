import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Executor public ownership boundary", () => {
  it("does not proxy Praxis or Contracts through Executor", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

    expect(source).not.toContain('export * from "@scry/praxis"');

    expect(source).not.toContain('from "@scry/praxis"');

    expect(source).not.toContain('from "@scry/contracts"');
  });

  it("does not retain the native-browser-navigation facade", async () => {
    await expect(
      access(new URL("../src/native-browser-navigation.ts", import.meta.url)),
    ).rejects.toThrow();
  });
});
