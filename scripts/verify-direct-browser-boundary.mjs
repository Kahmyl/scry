import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const browserMechanicsOwners = ["packages/praxis/src/", "packages/browser-runtime/src/"];
const browserV2WorkerCoordinator = "apps/api/src/browser-execution/browser-v2-worker-engine.ts";
const browserV2ActivationOwners = new Set([
  "apps/api/src/browser-execution/browser-execution-queue.service.ts",
  "apps/api/src/browser-execution/controllers/browser-lifecycle.controller.ts",
  "apps/api/src/browser-v2-main.ts",
  "apps/api/src/browser-v2-worker.ts",
]);

for (const candidate of deletedPaths) {
  if (existsSync(path.join(root, candidate)))
    violations.push(`${candidate}: displaced M1 path still exists`);
}

for (const file of filesToScan()) {
  const relative = path.relative(root, file);
  const source = readFileSync(file, "utf8");
  if (relative !== "scripts/verify-direct-browser-boundary.mjs") {
    for (const flag of executionFlags) {
      if (source.includes(flag)) violations.push(`${relative}: removed execution flag ${flag}`);
    }
  }
  const productionSource =
    !relative.includes("/test/") &&
    !relative.includes("/scripts/") &&
    !relative.startsWith("scripts/") &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative);
  const ownsBrowserMechanics =
    browserMechanicsOwners.some((owner) => relative.startsWith(owner)) ||
    relative === browserV2WorkerCoordinator;
  if (productionSource && /\b(?:chromium|firefox|webkit)\.launch\s*\(/.test(source)) {
    if (!ownsBrowserMechanics)
      violations.push(`${relative}: browser creation is outside an admitted owner`);
  }
  if (
    productionSource &&
    !ownsBrowserMechanics &&
    /\.(?:newContext|newPage|newCDPSession|goto|reload|waitForURL|waitForLoadState)\s*\(|\b(?:browser|context|page|candidate|popup|previousPage|uncertainContext)\.close\s*\(/.test(
      source,
    )
  ) {
    violations.push(`${relative}: browser lifecycle mechanics are outside an admitted owner`);
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

  if (
    productionSource &&
    !ownsBrowserMechanics &&
    browserActionMatches.length > 0 &&
    !admittedOperatorUiDownload
  ) {
    violations.push(`${relative}: browser action mechanics are outside an admitted owner`);
  }
  if (
    relative.startsWith("apps/api/src/") &&
    !relative.includes("/native-browser-driver/") &&
    relative !== browserV2WorkerCoordinator
  ) {
    if (
      /\.(?:getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|locator)\s*\(/.test(source)
    ) {
      violations.push(`${relative}: native locator execution is outside NativeBrowserDriver`);
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
    if (!activationOnly)
      violations.push(`${relative}: runtime path-selection *_ENABLED branch is forbidden`);
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

if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Browser execution ownership boundary verified.");

function filesToScan() {
  const result = [];
  for (const entry of scanRoots) visit(path.join(root, entry), result);
  return result;
}

function visit(candidate, result) {
  if (!existsSync(candidate)) return;
  const stat = statSync(candidate);
  if (stat.isDirectory()) {
    if (ignoredDirectories.has(path.basename(candidate))) return;
    for (const child of readdirSync(candidate)) visit(path.join(candidate, child), result);
    return;
  }
  if (
    sourceExtensions.has(path.extname(candidate)) ||
    path.basename(candidate).startsWith("docker-compose")
  ) {
    result.push(candidate);
  }
}
