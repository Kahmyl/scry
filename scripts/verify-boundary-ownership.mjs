import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url);
const productionPackages = [
  "apps/api",
  "apps/mcp",
  "apps/web",
  "packages/browser-runtime",
  "packages/contracts",
  "packages/praxis",
  "packages/veil",
  "packages/chronicle",
];

for (const packageDirectory of productionPackages) {
  const manifestPath = `${packageDirectory}/package.json`;
  if (!existsSync(new URL(manifestPath, root))) continue;
  const manifest = JSON.parse(read(manifestPath));
  if (manifest.dependencies?.["@scry/assurance"]) {
    fail(`production package depends on Assurance: ${manifestPath}`);
  }
}

const productionSources = productionPackages.flatMap((directory) =>
  sourceFiles(`${directory}/src`),
);
for (const sourcePath of productionSources) {
  const source = read(sourcePath);
  if (importSpecifiers(source).some((specifier) => specifier === "@scry/assurance")) {
    fail(`production source imports Assurance: ${sourcePath}`);
  }
  if (
    sourcePath !== "apps/api/src/browser-execution/browser-boundary-composition.ts" &&
    importSpecifiers(source).some((specifier) => specifier.endsWith("browser-worker-engine.js"))
  ) {
    fail(`browser worker engine bypasses application composition: ${sourcePath}`);
  }
  if (
    sourcePath.startsWith("apps/api/src/") &&
    ![
      "apps/api/src/browser-execution/browser-boundary-composition.ts",
      "apps/api/src/browser-execution/browser-worker-engine.ts",
    ].includes(sourcePath) &&
    /\bnew\s+ProtectionAuthority\s*\(/u.test(source)
  ) {
    fail(`protection authority is constructed outside an admitted adapter: ${sourcePath}`);
  }
}

const worker = read("apps/api/src/worker.ts");
if (!worker.includes("composePraxisExecutionPort") || worker.includes("BrowserWorkerEngine")) {
  fail("worker does not consume browser execution through the Praxis port");
}

const lifecycleRepository = read(
  "apps/api/src/browser-execution/repositories/browser-lifecycle.repository.ts",
);
if (
  importSpecifiers(lifecycleRepository).some(
    (specifier) => specifier === "@scry/browser-runtime",
  ) ||
  !lifecycleRepository.includes("VeilReportProtectionPort")
) {
  fail("report publication bypasses the Veil report protection port");
}

const contracts = read("packages/contracts/src/index.ts");
if (!contracts.includes('export * from "./boundary-ports.js"')) {
  fail("shared boundary ports are not exported");
}

const forbiddenExample = 'import { unsafe } from "@scry/assurance";';
if (!importSpecifiers(forbiddenExample).includes("@scry/assurance")) {
  fail("negative Assurance import characterization is ineffective");
}

process.stdout.write(
  `${JSON.stringify({
    verdict: "pass",
    praxisEntry: "PraxisExecutionPort",
    reportProtection: "VeilReportProtectionPort",
    productionAssuranceDependencies: 0,
  })}\n`,
);

function read(relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function sourceFiles(relativeDirectory) {
  const directory = new URL(`${relativeDirectory}/`, root);
  if (!existsSync(directory)) return [];
  const output = [];
  const visit = (absoluteDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const child = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.[cm]?[jt]sx?$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name)) {
        output.push(path.relative(root.pathname, child));
      }
    }
  };
  visit(directory.pathname);
  return output.sort();
}

function importSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s+["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function fail(message) {
  throw new Error(`SCRY_BOUNDARY_OWNERSHIP_VERIFICATION_FAILED: ${message}`);
}
