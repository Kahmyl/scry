import { readFileSync } from "node:fs";

const api = JSON.parse(read("apps/api/package.json"));
const mcp = JSON.parse(read("apps/mcp/package.json"));
const deploy = read("compose.deploy.yml");
const development = read("docker-compose.yml");
const dockerfile = read("Dockerfile");
const apiMain = read("apps/api/src/main.ts");
const apiWorker = read("apps/api/src/worker.ts");
const mcpMain = read("apps/mcp/src/main.ts");
const mcpHttp = read("apps/mcp/src/http.ts");
const browserMcp = [
  read("apps/mcp/src/browser-v2-main.ts"),
  read("apps/mcp/src/browser-v2-http.ts"),
  read("apps/mcp/src/browser-v2-server.ts"),
].join("\n");
const browserApiMain = read("apps/api/src/browser-v2-main.ts");
const browserWorker = read("apps/api/src/browser-v2-worker.ts");
const productApp = read("apps/web/src/app/ProductApp.tsx");
const schemaFingerprint = read("scripts/schema-fingerprint.mjs");

const exactScripts = {
  "@scry/api": [
    ["start", "tsx src/browser-v2-main.ts"],
    ["dev", "tsx watch src/browser-v2-main.ts"],
    ["worker", "tsx src/browser-v2-worker.ts"],
    ["db:migrate", "tsx scripts/migrate-browser-v2.ts"],
  ],
  "@scry/mcp": [
    ["start", "tsx src/browser-v2-main.ts"],
    ["start:http", "tsx src/browser-v2-http.ts"],
  ],
};
for (const [name, entries] of Object.entries(exactScripts)) {
  const manifest = name === "@scry/api" ? api : mcp;
  for (const [script, expected] of entries)
    if (manifest.scripts?.[script] !== expected)
      fail(`${name} ${script} does not select the production browser runtime`);
}

for (const [name, source, marker] of [
  ["API", apiMain, "LEGACY_API_RETIRED"],
  ["worker", apiWorker, "LEGACY_WORKER_RETIRED"],
  ["MCP stdio", mcpMain, "LEGACY_MCP_RETIRED"],
  ["MCP HTTP", mcpHttp, "LEGACY_MCP_HTTP_RETIRED"],
])
  if (!source.includes(marker)) fail(`${name} historical entrypoint remains executable`);

for (const forbidden of [
  "apps/api/src/main.ts",
  "apps/api/src/worker.ts",
  "apps/api/scripts/migrate.ts",
  "apps/mcp/src/http.ts",
])
  if (deploy.includes(forbidden)) fail(`production Compose references retired path: ${forbidden}`);

for (const required of [
  "apps/api/src/browser-v2-main.ts",
  "apps/api/src/browser-v2-worker.ts",
  "apps/api/scripts/migrate-browser-v2.ts",
  "apps/mcp/src/browser-v2-http.ts",
  "BROWSER_V2_REQUIRE_ACTIVATED_CUTOVER",
  "BROWSER_V2_PROTECTED_KEYS_JSON",
  "/api/v2/health",
])
  if (!deploy.includes(required))
    fail(`production Compose cutover requirement missing: ${required}`);

if (!development.includes("/api/v2/health")) fail("development health check is not on v2");
if (
  !dockerfile.includes(
    'CMD ["apps/api/node_modules/.bin/tsx", "--tsconfig", "apps/api/tsconfig.json", "apps/api/src/browser-v2-main.ts"]',
  )
)
  fail("Docker default command is not the browser execution API");
if (browserMcp.includes('from "./api-client.js"'))
  fail("browser MCP still imports the historical API client");
if (!browserMcp.includes('from "./browser-v2-api-client.js"'))
  fail("browser MCP does not use its isolated API client");
if (!browserApiMain.includes("assertCompatibleBaseline()"))
  fail("browser API does not refuse incompatible or unactivated state before listening");
if (!browserWorker.includes("assertCompatibleBaseline()"))
  fail("browser worker does not refuse incompatible or unactivated state before consuming jobs");
if (!productApp.includes('from "./BrowserV2Dashboard.js"'))
  fail("web runtime still selects the historical dashboard execution model");
if (
  !schemaFingerprint.includes("apps/api/migrations-v2/") ||
  schemaFingerprint.includes('apps/api/migrations/"')
)
  fail("release schema fingerprint does not select the browser v2 migration authority");

process.stdout.write(
  `${JSON.stringify({ verdict: "pass", runtimeAuthority: "browser-runtime-v2.7", legacyEntrypoints: "retired", productionActivationGate: "required" })}\n`,
);

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function fail(message) {
  throw new Error(`BROWSER_V2_CUTOVER_VERIFICATION_FAILED: ${message}`);
}
