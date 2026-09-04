import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const governance = JSON.parse(
  readFileSync(
    path.join(root, "docs/rearchitecture/RESPONSIBILITY-DISPOSITION-INVENTORY.json"),
    "utf8",
  ),
);

const phase1 = governance.phase1StaticExceptions;
if (!phase1) throw new Error("Phase 1 static exception ledger is missing");

const violations = [];

const deletedPaths = [
  "apps/api/src/direct-sessions",
  "apps/mcp/src/tools/direct-sessions",
  "packages/contracts/src/direct-session.ts",
  "apps/api/scripts/direct-session-vitract-campaign.ts",
  "apps/api/src/authoring/adaptive-authoring-flags.ts",
  "apps/api/src/runtime/adaptive-execution-flags.ts",
];

const executionFlags = [
  "SCRY_INTERACTIVE_PROBE_SESSIONS_ENABLED",
  "SCRY_CANDIDATE_ASSISTED_RESOLUTION_ENABLED",
  "SCRY_SELECTOR_HINTS_ENABLED",
  "SCRY_RISK_ADAPTIVE_THRESHOLDS_ENABLED",
  "SCRY_AUTHENTICATION_KERNEL_ENABLED",
  "SCRY_MALFORMED_CONTROL_CORPUS_ENABLED",
  "SCRY_PROTECTED_ACQUISITION_ADAPTERS_ENABLED",
  "SCRY_TRANSCRIPT_COMPILER_ENABLED",
  "SCRY_CERTIFICATION_PUBLICATION_GATE_ENABLED",
  "SCRY_RELEASE_CORPUS_GATE_ENABLED",
  "SCRY_DIRECT_BROWSER_ENABLED",
  "SCRY_DIRECT_EXTERNAL_ORIGINS",
  "SCRY_ORCHESTRATION_ENABLED",
  "SCRY_AUTHORING_TURN_ENABLED",
  "SCRY_EXECUTION_KERNEL_ENABLED",
];

const scanRoots = ["apps", "packages", "scripts", "docker-compose.yml", "compose.deploy.yml"];

const ignoredDirectories = new Set(["node_modules", "dist", "coverage", ".next", "artifacts"]);

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".yml", ".yaml"]);

const operatorUiDownloadAdapter = "apps/web/src/infrastructure/browser/download-blob.ts";

const praxisBrowserOwnerPrefix = "packages/praxis/src/";

const transitionalPlaywright = new Map(
  phase1.playwrightOutsidePraxisProductionSources.map((entry) => [entry.path, entry]),
);

const transitionalBrowserMechanics = new Map(
  phase1.browserMechanicsOutsidePraxisProductionSources.map((entry) => [entry.path, entry]),
);

const assuranceEvaluationInfrastructure = new Set(
  phase1.assuranceEvaluationInfrastructure.map(({ path }) => path),
);

if (transitionalPlaywright.size !== phase1.playwrightOutsidePraxisProductionSources.length) {
  violations.push("Phase 1 Playwright exception ledger contains duplicates");
}

if (
  transitionalBrowserMechanics.size !== phase1.browserMechanicsOutsidePraxisProductionSources.length
) {
  violations.push("Phase 1 browser-mechanics exception ledger contains duplicates");
}

const dispositionById = new Map(governance.dispositions.map((entry) => [entry.id, entry]));

for (const entry of [
  ...phase1.playwrightOutsidePraxisProductionSources,
  ...phase1.browserMechanicsOutsidePraxisProductionSources,
]) {
  const disposition = dispositionById.get(entry.dispositionId);

  if (!disposition) {
    violations.push(
      `browser exception references missing disposition: ${entry.path} -> ${entry.dispositionId}`,
    );
  } else if (disposition.disposition !== "DELETE_AFTER_CUTOVER") {
    violations.push(`browser exception is not owned by DELETE_AFTER_CUTOVER scope: ${entry.path}`);
  }
}

const browserV2ActivationOwners = new Set([
  "apps/api/src/browser-execution/browser-execution-queue.service.ts",
  "apps/api/src/browser-execution/controllers/browser-lifecycle.controller.ts",
  "apps/api/src/browser-v2-main.ts",
  "apps/api/src/browser-v2-worker.ts",
]);

for (const candidate of deletedPaths) {
  if (existsSync(path.join(root, candidate))) {
    violations.push(`${candidate}: displaced M1 path still exists`);
  }
}

const seenPlaywrightExceptions = new Set();
const seenBrowserMechanicsExceptions = new Set();
const seenAssuranceEvaluationInfrastructure = new Set();

for (const file of filesToScan()) {
  const relative = path.relative(root, file);
  const source = readFileSync(file, "utf8");

  if (relative !== "scripts/verify-direct-browser-boundary.mjs") {
    for (const flag of executionFlags) {
      if (source.includes(flag)) {
        violations.push(`${relative}: removed execution flag ${flag}`);
      }
    }
  }

  const productionSource =
    !relative.includes("/test/") &&
    !relative.includes("/tests/") &&
    !relative.includes("/__tests__/") &&
    !relative.includes("/scripts/") &&
    !relative.startsWith("scripts/") &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative);

  const praxisOwned = relative.startsWith(praxisBrowserOwnerPrefix);
  const assuranceEvaluation = assuranceEvaluationInfrastructure.has(relative);
  const playwrightImport = importsPlaywright(source);

  if (assuranceEvaluation) {
    seenAssuranceEvaluationInfrastructure.add(relative);
  }

  if (productionSource && playwrightImport && !praxisOwned && !assuranceEvaluation) {
    if (transitionalPlaywright.has(relative)) {
      seenPlaywrightExceptions.add(relative);
    } else {
      violations.push(
        `${relative}: Playwright import is outside Praxis or explicit Assurance evaluation`,
      );
    }
  }

  const browserActionPattern =
    /\.(?:click|dblclick|fill|type|selectOption|setChecked|check|uncheck|press|hover|dragTo|setInputFiles|waitForEvent)\s*\(|\.(?:keyboard|mouse)\.(?:press|type|down|up|click|dblclick|move|wheel)\s*\(/g;

  const browserActionMatches = source.match(browserActionPattern) ?? [];

  const admittedOperatorUiDownload =
    relative === operatorUiDownloadAdapter &&
    browserActionMatches.length === 1 &&
    browserActionMatches[0].startsWith(".click(") &&
    /document\.createElement\(["']a["']\)/.test(source) &&
    /\.download\s*=/.test(source) &&
    /URL\.createObjectURL\s*\(/.test(source) &&
    /URL\.revokeObjectURL\s*\(/.test(source);

  const browserMechanics =
    /\b(?:chromium|firefox|webkit)\.launch\s*\(/.test(source) ||
    /\.(?:newContext|newPage|newCDPSession|goto|reload|waitForURL|waitForLoadState)\s*\(/.test(
      source,
    ) ||
    /\b(?:browser|context|page|candidate|popup|previousPage|uncertainContext)\.close\s*\(/.test(
      source,
    ) ||
    browserActionMatches.length > 0 ||
    /\.(?:getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|locator)\s*\(/.test(source);

  if (
    productionSource &&
    browserMechanics &&
    !praxisOwned &&
    !assuranceEvaluation &&
    !admittedOperatorUiDownload
  ) {
    if (transitionalBrowserMechanics.has(relative)) {
      seenBrowserMechanicsExceptions.add(relative);
    } else {
      violations.push(`${relative}: browser mechanics are outside Praxis`);
    }
  }

  if (
    productionSource &&
    /process\.env(?:\.[A-Z0-9_]*_ENABLED|\[["'][A-Z0-9_]*_ENABLED["']\])/.test(source)
  ) {
    const enabledReferences = [
      ...source.matchAll(
        /process\.env(?:\.([A-Z0-9_]*_ENABLED)|\[["']([A-Z0-9_]*_ENABLED)["']\])/g,
      ),
    ];

    const failClosedBrowserV2Guards = [
      ...source.matchAll(/if\s*\(\s*process\.env\.BROWSER_V2_ENABLED\s*!==\s*["']true["']\s*\)/g),
    ];

    const activationOnly =
      browserV2ActivationOwners.has(relative) &&
      enabledReferences.every((match) => (match[1] ?? match[2]) === "BROWSER_V2_ENABLED") &&
      failClosedBrowserV2Guards.length === enabledReferences.length;

    if (!activationOnly) {
      violations.push(`${relative}: runtime path-selection *_ENABLED branch is forbidden`);
    }
  }

  if (
    relative.startsWith("apps/mcp/src/") &&
    /\b(?:start|execute|observe|close)_direct_session\b/.test(source)
  ) {
    violations.push(`${relative}: deleted direct-session MCP tool is still exposed`);
  }

  if (
    relative === "apps/api/src/runtime/native-browser-driver/native-browser-driver.ts" &&
    /\b(?:sessions\s*=\s*new Map|async (?:start|turn|observe|close)\s*\()/.test(source)
  ) {
    violations.push(`${relative}: independent browser-session ownership is forbidden`);
  }
}

for (const exception of transitionalPlaywright.keys()) {
  if (!seenPlaywrightExceptions.has(exception)) {
    violations.push(`stale Phase 1 Playwright exception: ${exception}`);
  }
}

for (const exception of transitionalBrowserMechanics.keys()) {
  if (!seenBrowserMechanicsExceptions.has(exception)) {
    violations.push(`stale Phase 1 browser-mechanics exception: ${exception}`);
  }
}

for (const exception of assuranceEvaluationInfrastructure) {
  if (!seenAssuranceEvaluationInfrastructure.has(exception)) {
    violations.push(`missing explicit Assurance evaluation infrastructure: ${exception}`);
  }
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(
  `Browser execution ownership boundary verified; ${transitionalPlaywright.size} frozen Playwright exceptions and ${transitionalBrowserMechanics.size} frozen browser-mechanics exceptions remain outside Praxis.`,
);

function importsPlaywright(source) {
  return (
    /\bfrom\s+["'](?:playwright|playwright-core)["']/.test(source) ||
    /\bimport\s+["'](?:playwright|playwright-core)["']/.test(source) ||
    /\bimport\s*\(\s*["'](?:playwright|playwright-core)["']\s*\)/.test(source) ||
    /\brequire\s*\(\s*["'](?:playwright|playwright-core)["']\s*\)/.test(source)
  );
}

function filesToScan() {
  const result = [];

  for (const entry of scanRoots) {
    visit(path.join(root, entry), result);
  }

  return result;
}

function visit(candidate, result) {
  if (!existsSync(candidate)) return;

  const stat = statSync(candidate);

  if (stat.isDirectory()) {
    if (ignoredDirectories.has(path.basename(candidate))) return;

    for (const child of readdirSync(candidate)) {
      visit(path.join(candidate, child), result);
    }

    return;
  }

  if (
    sourceExtensions.has(path.extname(candidate)) ||
    path.basename(candidate).startsWith("docker-compose")
  ) {
    result.push(candidate);
  }
}
