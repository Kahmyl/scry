import { fileURLToPath as qualificationFilePath } from "node:url";
process.chdir(qualificationFilePath(new URL("../../../", import.meta.url)));
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { boundaryViolations } from "./boundary-ownership-rules.mjs";

const root = new URL("../../../", import.meta.url);
const productionPackages = [
  "apps/api",
  "apps/mcp",
  "apps/web",
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
  if (
    importSpecifiers(source).some(
      (specifier) =>
        /^@scry\/assurance(?:\/|$)/u.test(specifier) ||
        (specifier.startsWith(".") &&
          path.posix
            .normalize(path.posix.join(path.posix.dirname(sourcePath), specifier))
            .startsWith("packages/assurance/")),
    )
  ) {
    fail(`production source imports Assurance: ${sourcePath}`);
  }
  if (
    sourcePath !== "apps/api/src/browser-execution/browser-boundary-composition.ts" &&
    /\bnew\s+PraxisBrowserEngine\s*\(/u.test(source)
  ) {
    fail(`browser worker engine bypasses application composition: ${sourcePath}`);
  }
  if (
    sourcePath.startsWith("apps/api/src/") &&
    !["apps/api/src/browser-execution/browser-boundary-composition.ts"].includes(sourcePath) &&
    /\bnew\s+ProtectionAuthority\s*\(/u.test(source)
  ) {
    fail(`protection authority is constructed outside an admitted adapter: ${sourcePath}`);
  }
}

const boundaryConsumers = [
  ...sourceFiles("apps/api/src/browser-execution"),
  ...sourceFiles("packages/praxis/src"),
  ...sourceFiles("packages/veil/src"),
  ...sourceFiles("packages/chronicle/src"),
  ...sourceFiles("packages/assurance/src"),
  ...sourceFiles("packages/assurance/test", true),
];
for (const sourcePath of boundaryConsumers) {
  const violations = boundaryViolations(sourcePath, read(sourcePath));
  if (violations.length) fail(`${sourcePath}: ${violations.join("; ")}`);
}
for (const displaced of [
  "packages/browser-runtime/src/classifier.ts",
  "packages/browser-runtime/src/sanitizer.ts",
  "packages/browser-runtime/src/protection-authority.ts",
  "packages/browser-runtime/src/protected-capture-vault.ts",
  "apps/api/src/browser-execution/browser-protected-keyring.ts",
  "packages/veil/src/authority.ts",
  "packages/veil/src/policy.ts",
  "packages/veil/src/runtime-coordinator.ts",
  "packages/browser-runtime/src/authenticated-evidence-store.ts",
  "packages/browser-runtime/src/offline-renderer.ts",
  "packages/browser-runtime/src/effect-ledger.ts",
  "packages/browser-runtime/src/browser-owner-supervisor.ts",
  "packages/chronicle/src/legacy/index.ts",
  "packages/browser-runtime/package.json",
  "apps/api/src/browser-execution/browser-worker-engine.ts",
  "packages/praxis/src/adapter.ts",
  "packages/praxis/src/runtime.ts",
]) {
  if (existsSync(new URL(displaced, root)))
    fail(`displaced boundary implementation remains: ${displaced}`);
}
const veilPackage = JSON.parse(read("packages/veil/package.json"));
const assurancePackage = JSON.parse(read("packages/assurance/package.json"));
if (Object.keys(assurancePackage.dependencies ?? {}).some((name) => name !== "@scry/contracts"))
  fail("Assurance analysis has an implementation dependency outside public contracts");
if (
  Object.keys(assurancePackage.devDependencies ?? {}).some(
    (name) =>
      name === "pg" ||
      name.startsWith("@nestjs/") ||
      /^@scry\/(?!contracts$|praxis$|veil$|chronicle$)/u.test(name),
  )
)
  fail("Assurance fixtures depend on application internals or a database driver");
for (const retired of [
  "src/architecture",
  "src/agent-lab",
  "src/engineering-lab",
  "src/campaigns",
  "scripts/q0.ts",
  "scripts/q1.ts",
  "scripts/q2.ts",
  "scripts/q3.ts",
  "scripts/m4.ts",
  "scripts/m6.ts",
]) {
  if (
    sourceFiles(`packages/assurance/${retired}`).length ||
    (/\.ts$/u.test(retired) && existsSync(new URL(`packages/assurance/${retired}`, root)))
  )
    fail(`retired Assurance workflow remains: ${retired}`);
}
if (Object.keys(veilPackage.dependencies ?? {}).some((name) => name !== "@scry/contracts"))
  fail("Veil has an implementation dependency outside its contracts");
for (const consumer of ["apps/api"]) {
  const manifest = JSON.parse(read(`${consumer}/package.json`));
  if (!manifest.dependencies?.["@scry/veil"])
    fail(`${consumer} does not declare its Veil runtime dependency`);
}
const chroniclePackage = JSON.parse(read("packages/chronicle/package.json"));
if (Object.keys(chroniclePackage.dependencies ?? {}).some((name) => name !== "@scry/contracts"))
  fail("Chronicle has an implementation dependency outside its contracts");
const runtimePackage = JSON.parse(read("packages/praxis/package.json"));
if (
  Object.keys(runtimePackage.dependencies ?? {}).some(
    (name) => !["@scry/contracts", "playwright", "rrweb"].includes(name),
  )
)
  fail("browser mechanics depend directly on protection or evidence implementations");
if (!JSON.parse(read("apps/api/package.json")).dependencies?.["@scry/chronicle"])
  fail("application does not declare its Chronicle runtime dependency");
if (!JSON.parse(read("apps/api/package.json")).dependencies?.["@scry/praxis"])
  fail("application does not declare its Praxis runtime dependency");

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
if (!contracts.includes('export * from "./chronicle-ports.js"'))
  fail("Chronicle capability ports are not exported");
if (!contracts.includes('export * from "./praxis-ports.js"'))
  fail("Praxis capability ports are not exported");

const forbiddenExample = 'import { unsafe } from "@scry/assurance";';
if (!importSpecifiers(forbiddenExample).includes("@scry/assurance")) {
  fail("negative Assurance import characterization is ineffective");
}

process.stdout.write(
  `${JSON.stringify({
    verdict: "pass",
    praxisEntry: "PraxisExecutionPort",
    reportProtection: "VeilReportProtectionPort",
    protectionAuthority: "@scry/veil",
    evidenceAuthority: "@scry/chronicle",
    productionAssuranceDependencies: 0,
  })}\n`,
);

function read(relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function sourceFiles(relativeDirectory, includeTests = false) {
  const directory = new URL(`${relativeDirectory}/`, root);
  if (!existsSync(directory)) return [];
  const output = [];
  const visit = (absoluteDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const child = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (
        /\.[cm]?[jt]sx?$/u.test(entry.name) &&
        (includeTests || !/\.(?:test|spec)\./u.test(entry.name))
      ) {
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
