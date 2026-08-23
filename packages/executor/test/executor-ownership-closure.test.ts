import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Executor ownership closure", () => {
  it("retains only the execution-kernel port rather than displaced ownership", async () => {
    for (const retired of [
      "../src/authoring-browser-session.ts",
      "../src/external-resource-target-preparation.ts",
      "../src/protected-transaction-runtime.ts",
    ]) {
      await expect(access(new URL(retired, import.meta.url))).rejects.toThrow();
    }

    await expect(
      access(new URL("../src/protected-transaction-port.ts", import.meta.url)),
    ).resolves.toBeUndefined();

    await expect(
      access(new URL("../../praxis/src/external-resource-target-preparation.ts", import.meta.url)),
    ).resolves.toBeUndefined();

    await expect(
      access(new URL("../../praxis/src/lifecycle/authoring-browser-session.ts", import.meta.url)),
    ).resolves.toBeUndefined();

    const executorIndex = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

    expect(executorIndex).not.toContain("authoring-browser-session");

    expect(executorIndex).not.toContain("external-resource-target-preparation");

    expect(executorIndex).not.toContain("protected-transaction-runtime");

    expect(executorIndex).toContain('export * from "./protected-transaction-port.js";');
  });
});
