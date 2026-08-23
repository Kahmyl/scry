import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("Assurance public boundary", () => {
  it("does not publicly export the quarantined legacy surface", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(root, "packages/assurance/package.json"), "utf8"),
    ) as {
      exports?: Record<string, string>;
    };

    expect(packageJson.exports?.["./legacy"]).toBeUndefined();
  });

  it("keeps clean Assurance source independent of legacy implementation", async () => {
    const sourceRoot = path.join(root, "packages/assurance/src");

    const files = await collectTypeScript(sourceRoot);

    const cleanFiles = files.filter((file) => !file.includes(`${path.sep}legacy${path.sep}`));

    for (const file of cleanFiles) {
      const source = await readFile(file, "utf8");

      expect(source, file).not.toContain("/legacy/");

      expect(source, file).not.toContain("./legacy");
    }
  });

  it("keeps active API scripts off @scry/assurance/legacy", async () => {
    const scriptsRoot = path.join(root, "apps/api/scripts");

    const files = await collectTypeScript(scriptsRoot);

    for (const file of files) {
      const source = await readFile(file, "utf8");

      expect(source, file).not.toContain("@scry/assurance/legacy");
    }
  });
});

async function collectTypeScript(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });

  const files: string[] = [];

  for (const entry of entries) {
    const target = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectTypeScript(target)));

      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(target);
    }
  }

  return files;
}
