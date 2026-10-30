import { fileURLToPath as qualificationFilePath } from "node:url";
process.chdir(qualificationFilePath(new URL("../../../", import.meta.url)));
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const api = JSON.parse(read("apps/api/package.json"));
const mcp = JSON.parse(read("apps/mcp/package.json"));
const deployment = read("compose.deploy.yml");
const development = read("docker-compose.yml");
const dockerfile = read("Dockerfile");

const exactScripts = {
  "@scry/api": [
    ["start", "tsx src/main.ts"],
    ["dev", "tsx watch src/main.ts"],
    ["worker", "tsx src/worker.ts"],
    ["db:migrate", "tsx scripts/migrate.ts"],
  ],
  "@scry/mcp": [
    ["start", "tsx src/main.ts"],
    ["start:http", "tsx src/http.ts"],
  ],
};
for (const [name, entries] of Object.entries(exactScripts)) {
  const manifest = name === "@scry/api" ? api : mcp;
  for (const [script, expected] of entries) {
    if (manifest.scripts?.[script] !== expected) {
      fail(`${name} ${script} does not select the baseline runtime`);
    }
  }
}

for (const path of [
  "apps/api/src/main.ts",
  "apps/api/src/worker.ts",
  "apps/api/src/app.module.ts",
  "apps/api/scripts/migrate.ts",
  "apps/api/src/browser-execution/browser-schema.ts",
  "apps/mcp/src/main.ts",
  "apps/mcp/src/http.ts",
  "apps/mcp/src/server.ts",
  "apps/mcp/src/api-client.ts",
  "apps/web/src/app/Dashboard.tsx",
  "apps/web/src/app/ProjectSettings.tsx",
  "packages/contracts/src/browser-execution.ts",
  "packages/contracts/src/browser-command.ts",
  "packages/contracts/src/browser-lifecycle.ts",
]) {
  if (!existsSync(new URL(`../../../${path}`, import.meta.url)))
    fail(`baseline file missing: ${path}`);
}

for (const removedPath of [
  // These unused modules pulled a retired package into the baseline type graph.
  // The active app composes the auth providers and database ports directly.
  "apps/api/src/auth/auth.module.ts",
  "apps/api/src/auth/index.ts",
  "apps/api/src/infrastructure/index.ts",
  "apps/api/src/infrastructure/infrastructure.module.ts",
  "apps/api/src/infrastructure/operational-event-store.ts",
  "apps/api/src/infrastructure/operational-events.controller.ts",
  "apps/api/src/infrastructure/operational-events.ts",
  "apps/api/src/browser-v2-main.ts",
  "apps/api/src/browser-v2-worker.ts",
  "apps/api/src/browser-v2-app.module.ts",
  "apps/mcp/src/browser-v2-main.ts",
  "apps/mcp/src/browser-v2-http.ts",
  "packages/contracts/src/browser-execution-v2.ts",
  "apps/web/src/app/BrowserV2Dashboard.tsx",
]) {
  if (existsSync(new URL(`../../../${removedPath}`, import.meta.url))) {
    fail(`retired product path remains: ${removedPath}`);
  }
}

for (const required of [
  "apps/api/src/main.ts",
  "apps/api/src/worker.ts",
  "apps/api/scripts/migrate.ts",
  "apps/mcp/src/http.ts",
  "SCRY_BROWSER_REQUIRE_ACTIVATED_CUTOVER",
  "SCRY_BROWSER_PROTECTED_KEYS_JSON",
  "/api/health",
]) {
  if (!deployment.includes(required)) fail(`deployment requirement missing: ${required}`);
}
if (!development.includes("/api/health")) fail("development API health route is incorrect");
if (!dockerfile.includes('"apps/api/src/main.ts"')) {
  fail("container default command is not the baseline API");
}

const apiMain = read("apps/api/src/main.ts");
const apiWorker = read("apps/api/src/worker.ts");
if (!apiMain.includes("assertCompatibleBaseline()")) {
  fail("API does not verify database capabilities before listening");
}
if (!apiWorker.includes("assertCompatibleBaseline()")) {
  fail("worker does not verify database capabilities before consuming jobs");
}

const schemaCheck = read("apps/api/src/browser-execution/browser-schema.ts");
if (!schemaCheck.includes("information_schema.columns")) {
  fail("database readiness is not capability based");
}
if (schemaCheck.includes("createHash") || schemaCheck.includes("pg_indexes")) {
  fail("database readiness still uses an exact schema fingerprint");
}

const protectedKeyring = read("packages/veil/src/protected-keyring.ts");
const browserProtection = read("packages/veil/src/browser-protection.ts");
const evidenceStore = read("packages/chronicle/src/authenticated-evidence-store.ts");
if (
  !protectedKeyring.includes("deriveLegacy") ||
  !protectedKeyring.includes("scry/browser-v2") ||
  !browserProtection.includes('deriveLegacy(scope.protectionKeyId, "evidence"') ||
  !browserProtection.includes("legacyEncryptionKeys") ||
  !evidenceStore.includes("evidenceVersion")
) {
  fail("historical encrypted-data read compatibility is incomplete");
}

const activeSourcePaths = [
  "apps/api/src/main.ts",
  "apps/api/src/worker.ts",
  "apps/api/src/app.module.ts",
  ...sourceFiles("apps/api/src/auth"),
  ...sourceFiles("apps/api/src/common"),
  "apps/api/src/infrastructure/database.ts",
  "apps/api/src/infrastructure/redis.ts",
  ...sourceFiles("apps/api/src/browser-execution"),
  "apps/mcp/src/main.ts",
  "apps/mcp/src/http.ts",
  "apps/mcp/src/server.ts",
  "apps/mcp/src/api-client.ts",
  "apps/mcp/src/tool-registry.ts",
  "apps/web/src/app/ProductApp.tsx",
  "apps/web/src/app/Dashboard.tsx",
  "apps/web/src/app/ProjectSettings.tsx",
  ...sourceFiles("packages/praxis/src"),
  ...sourceFiles("packages/veil/src"),
  ...sourceFiles("packages/chronicle/src"),
  "packages/contracts/src/index.ts",
  "packages/contracts/src/browser-execution.ts",
  "packages/contracts/src/browser-command.ts",
  "packages/contracts/src/browser-lifecycle.ts",
];
const activeSources = activeSourcePaths.map(read).join("\n");
const productIdentitySources = activeSources
  .replaceAll("browser-v2-key-1", "persisted-key-id")
  .replaceAll("scry/browser-v2", "persisted-kdf-domain")
  .replaceAll(/BROWSER_V2_PROTECTED_(?:KEY_VERSION|KEYS_JSON|KEY_BASE64)/gu, "LEGACY_KEY_ENV");
if (/browser[-_ ]?v\d|browser-runtime-v\d|\/api\/v\d/iu.test(productIdentitySources)) {
  fail("a numbered Scry product generation remains in the active baseline");
}
if (/schema_fingerprint|catalog_fingerprint/iu.test(activeSources + deployment)) {
  fail("exact schema fingerprint admission remains active");
}

const browserLaunchOwners = new Set([
  "packages/praxis/src/browser-engine.ts",
  "packages/praxis/src/replay-browser.ts",
]);
for (const sourcePath of activeSourcePaths) {
  const source = read(sourcePath);
  if (/\b(?:chromium|firefox|webkit)\.launch\s*\(/u.test(source)) {
    if (!browserLaunchOwners.has(sourcePath)) {
      fail(`browser launch is outside an admitted baseline owner: ${sourcePath}`);
    }
  }
  if (
    sourcePath.startsWith("apps/api/src/") &&
    /\.(?:click|dblclick|fill|type|selectOption|setChecked|check|uncheck|press|hover|dragTo|setInputFiles|newContext|newPage|goto|reload|waitForURL|waitForLoadState)\s*\(/u.test(
      source,
    )
  ) {
    fail(`browser mechanics are outside Praxis: ${sourcePath}`);
  }
}

const activationOwners = new Set([
  "apps/api/src/main.ts",
  "apps/api/src/worker.ts",
  "apps/api/src/browser-execution/browser-execution-queue.service.ts",
  "apps/api/src/browser-execution/controllers/browser-lifecycle.controller.ts",
]);
for (const sourcePath of activeSourcePaths) {
  const enabledFlags = [...read(sourcePath).matchAll(/process\.env\.([A-Z0-9_]+_ENABLED)\b/gu)].map(
    (match) => match[1],
  );
  if (enabledFlags.some((flag) => flag !== "SCRY_BROWSER_ENABLED")) {
    fail(`alternate runtime feature flag remains active: ${sourcePath}`);
  }
  if (enabledFlags.length > 0 && !activationOwners.has(sourcePath)) {
    fail(`browser activation is checked outside an admitted owner: ${sourcePath}`);
  }
}

process.stdout.write(
  `${JSON.stringify({
    verdict: "pass",
    runtimeAuthority: "browser-execution",
    schemaAdmission: "required-capabilities",
    productionActivationGate: "required",
  })}\n`,
);

function read(path) {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

function sourceFiles(relativeDirectory) {
  const absoluteDirectory = new URL(`../../../${relativeDirectory}/`, import.meta.url);
  if (!existsSync(absoluteDirectory)) return [];
  const output = [];
  const visit = (absolutePath) => {
    for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
      const child = path.join(absolutePath, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.[cm]?[jt]sx?$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name)) {
        output.push(path.relative(new URL("../../../", import.meta.url).pathname, child));
      }
    }
  };
  if (statSync(absoluteDirectory).isDirectory()) visit(absoluteDirectory.pathname);
  return output.sort();
}

function fail(message) {
  throw new Error(`SCRY_BASELINE_TOPOLOGY_VERIFICATION_FAILED: ${message}`);
}
