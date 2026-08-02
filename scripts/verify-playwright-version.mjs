import { readFile } from "node:fs/promises";

const executorPackage = JSON.parse(await readFile(new URL("../packages/executor/package.json", import.meta.url), "utf8"));
const expected = executorPackage.dependencies?.playwright;

if (!/^\d+\.\d+\.\d+$/.test(expected ?? "")) {
  throw new Error(`@scry/executor must pin Playwright exactly; received ${JSON.stringify(expected)}`);
}

const files = ["Dockerfile", "docker/Dockerfile.worker"];
const failures = [];
for (const file of files) {
  const contents = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const imageVersion = contents.match(/^ARG PLAYWRIGHT_VERSION=(\d+\.\d+\.\d+)$/m)?.[1];
  if (imageVersion !== expected) failures.push(`${file}: expected ${expected}, found ${imageVersion ?? "no pinned ARG"}`);
}

const lockfile = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const executorImporter = lockfile.match(/  packages\/executor:\n([\s\S]*?)(?=\n  \S|\npackages:)/)?.[1] ?? "";
const lockedSpecifier = executorImporter.match(/      playwright:\n        specifier: ([^\n]+)/)?.[1];
const lockedVersion = executorImporter.match(/      playwright:\n        specifier: [^\n]+\n        version: ([^\n]+)/)?.[1];
if (lockedSpecifier !== expected || lockedVersion !== expected) {
  failures.push(`pnpm-lock.yaml: expected ${expected}, found specifier=${lockedSpecifier} version=${lockedVersion}`);
}

if (failures.length) {
  throw new Error(`Playwright runtime compatibility check failed:\n- ${failures.join("\n- ")}`);
}

process.stdout.write(`Playwright package and runner images agree on ${expected}.\n`);
