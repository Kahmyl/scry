import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("Assurance public boundary", () => {
  it("does not publicly export a legacy Assurance surface", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(root, "packages/assurance/package.json"), "utf8"),
    ) as {
      exports?: Record<string, string>;
    };

    expect(packageJson.exports?.["./legacy"]).toBeUndefined();
  });

  it("has no retired source or campaign quarantine directories", async () => {
    await expect(access(path.join(root, "packages/assurance/src/legacy"))).rejects.toThrow();

    await expect(
      access(path.join(root, "packages/assurance/scripts/legacy-campaigns")),
    ).rejects.toThrow();
  });

  it("keeps active API scripts off the retired Assurance legacy package", async () => {
    const scriptsRoot = path.join(root, "apps/api/scripts");

    const files = await collectTypeScript(scriptsRoot);

    const forbidden = ["@scry", "assurance", "legacy"].join("/");

    for (const file of files) {
      const source = await readFile(file, "utf8");

      expect(source, file).not.toContain(forbidden);
    }
  });

  it("keeps qualification campaigns in the normal Assurance campaign directory", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(root, "packages/assurance/package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };

    const campaignScripts = Object.entries(packageJson.scripts ?? {}).filter(([name]) =>
      name.startsWith("campaign:"),
    );

    expect(campaignScripts.length).toBeGreaterThan(0);

    for (const [name, command] of campaignScripts) {
      expect(command, name).toContain("scripts/campaigns/");

      expect(command, name).not.toContain("legacy-campaigns");
    }
  });

  it("does not expose certification-named Assurance campaign commands", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(root, "packages/assurance/package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };

    const names = Object.keys(packageJson.scripts ?? {}).filter((name) =>
      name.startsWith("campaign:"),
    );

    expect(names.some((name) => name.includes("certification"))).toBe(false);

    expect(names).toContain("campaign:praxis:qualification");

    expect(names).toContain("campaign:veil:qualification");
  });

  it("keeps Assurance downstream of production runtime source", async () => {
    const productionRoots: string[] = [];

    for (const parent of ["apps", "packages"]) {
      const entries = await readdir(path.join(root, parent), { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || (parent === "packages" && entry.name === "assurance")) {
          continue;
        }

        const sourceRoot = path.join(root, parent, entry.name, "src");

        try {
          await access(sourceRoot);
          productionRoots.push(sourceRoot);
        } catch {
          // A workspace without a production source root cannot import Assurance at runtime.
        }
      }
    }

    for (const productionRoot of productionRoots) {
      for (const file of await collectTypeScript(productionRoot)) {
        const source = await readFile(file, "utf8");

        expect(source, file).not.toMatch(/(?:from\s*|import\s*)["']@scry\/assurance["']/);
      }
    }
  }, 15_000);
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
