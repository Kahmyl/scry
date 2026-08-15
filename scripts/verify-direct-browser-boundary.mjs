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

for (const candidate of deletedPaths) {
  if (existsSync(path.join(root, candidate))) violations.push(`${candidate}: displaced M1 path still exists`);
}

for (const file of filesToScan()) {
  const relative = path.relative(root, file);
  const source = readFileSync(file, "utf8");
  if (relative !== "scripts/verify-direct-browser-boundary.mjs") {
    for (const flag of executionFlags) {
      if (source.includes(flag)) violations.push(`${relative}: removed execution flag ${flag}`);
    }
  }
  const productionSource = !relative.includes("/test/") && !relative.includes("/scripts/") &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative);
  if (productionSource && /\b(?:chromium|firefox|webkit)\.launch\s*\(/.test(source)) {
    const allowed = new Set([
      "packages/praxis/src/lifecycle/browser-session.ts",
    ]);
    if (!allowed.has(relative)) violations.push(`${relative}: browser creation is outside an admitted owner`);
  }
  if (
    productionSource &&
    !relative.startsWith("packages/praxis/src/") &&
    /\.(?:newContext|newPage|newCDPSession|goto|reload|waitForURL|waitForLoadState)\s*\(|\b(?:browser|context|page|candidate|popup|previousPage|uncertainContext)\.close\s*\(/.test(source)
  ) {
    violations.push(`${relative}: browser lifecycle mechanics are outside Praxis`);
  }
  if (
    productionSource &&
    !relative.startsWith("packages/praxis/src/") &&
    /\.(?:click|dblclick|fill|type|selectOption|setChecked|check|uncheck|press|hover|dragTo|setInputFiles|waitForEvent)\s*\(|\.(?:keyboard|mouse)\.(?:press|type|down|up|click|dblclick|move|wheel)\s*\(/.test(source)
  ) {
    violations.push(`${relative}: browser action mechanics are outside Praxis`);
  }
  if (relative.startsWith("apps/api/src/") && !relative.includes("/native-browser-driver/")) {
    if (/\.(?:getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|locator)\s*\(/.test(source)) {
      violations.push(`${relative}: native locator execution is outside NativeBrowserDriver`);
    }
  }
  if (productionSource && /process\.env(?:\.[A-Z0-9_]*_ENABLED|\[["'][A-Z0-9_]*_ENABLED["']\])/.test(source)) {
    violations.push(`${relative}: runtime path-selection *_ENABLED branch is forbidden`);
  }
  if (relative.startsWith("apps/mcp/src/") && /\b(?:start|execute|observe|close)_direct_session\b/.test(source)) {
    violations.push(`${relative}: deleted direct-session MCP tool is still exposed`);
  }
  if (relative === "apps/api/src/runtime/native-browser-driver/native-browser-driver.ts" &&
      /\b(?:sessions\s*=\s*new Map|async (?:start|turn|observe|close)\s*\()/.test(source)) {
    violations.push(`${relative}: independent browser-session ownership is forbidden`);
  }
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Mission-first M1 execution ownership boundary verified.");

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
  if (sourceExtensions.has(path.extname(candidate)) || path.basename(candidate).startsWith("docker-compose")) {
    result.push(candidate);
  }
}
