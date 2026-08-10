import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const dockerfiles = ["docker/Dockerfile.dev", "docker/Dockerfile.worker"];

describe("API image workspace dependency layer", () => {
  it.each(dockerfiles)("installs the campaigns workspace dependencies in %s", async (file) => {
    const contents = await readFile(new URL(`../../../${file}`, import.meta.url), "utf8");
    const manifest = "COPY packages/campaigns/package.json packages/campaigns/package.json";

    expect(contents.indexOf(manifest)).toBeGreaterThanOrEqual(0);
    expect(contents.indexOf(manifest)).toBeLessThan(contents.indexOf("pnpm install --frozen-lockfile"));
  });
});
