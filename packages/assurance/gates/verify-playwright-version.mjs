import { fileURLToPath as qualificationFilePath } from "node:url";
process.chdir(qualificationFilePath(new URL("../../../", import.meta.url)));
import { readFile } from "node:fs/promises";

const browserRuntimePackage = JSON.parse(
  await readFile(new URL("../../../packages/praxis/package.json", import.meta.url), "utf8"),
);
const expected = browserRuntimePackage.dependencies?.playwright;

if (!/^\d+\.\d+\.\d+$/.test(expected ?? "")) {
  throw new Error(`@scry/praxis must pin Playwright exactly; received ${JSON.stringify(expected)}`);
}

const files = ["Dockerfile", "docker/Dockerfile.worker"];
const failures = [];
for (const file of files) {
  const contents = await readFile(new URL(`../../../${file}`, import.meta.url), "utf8");
  const imageVersion = contents.match(/^ARG PLAYWRIGHT_VERSION=(\d+\.\d+\.\d+)$/m)?.[1];
  if (imageVersion !== expected)
    failures.push(`${file}: expected ${expected}, found ${imageVersion ?? "no pinned ARG"}`);
}

const lockfile = await readFile(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
const browserRuntimeImporter =
  lockfile.match(/  packages\/praxis:\n([\s\S]*?)(?=\n  \S|\npackages:)/)?.[1] ?? "";
const lockedSpecifier = browserRuntimeImporter.match(
  /      playwright:\n        specifier: ([^\n]+)/,
)?.[1];
const lockedVersion = browserRuntimeImporter.match(
  /      playwright:\n        specifier: [^\n]+\n        version: ([^\n]+)/,
)?.[1];
if (lockedSpecifier !== expected || lockedVersion !== expected) {
  failures.push(
    `pnpm-lock.yaml: expected ${expected}, found specifier=${lockedSpecifier} version=${lockedVersion}`,
  );
}

// Both pinned drivers export a bin named playwright. pnpm's generated shim can
// select the MCP alias, whose browser revision differs from the stable driver.
for (const file of [
  ".github/workflows/qualification-browser.yml",
  ".github/workflows/qualification-database.yml",
]) {
  const contents = await readFile(new URL(`../../../${file}`, import.meta.url), "utf8");
  if (
    !contents.includes(
      "node packages/praxis/node_modules/playwright/cli.js install --with-deps chromium",
    ) ||
    contents.includes("exec playwright install")
  )
    failures.push(
      `${file}: install the stable browser through its explicit package CLI, not the shared bin`,
    );
}

if (failures.length) {
  throw new Error(`Playwright runtime compatibility check failed:\n- ${failures.join("\n- ")}`);
}

process.stdout.write(`Playwright package and runner images agree on ${expected}.\n`);
