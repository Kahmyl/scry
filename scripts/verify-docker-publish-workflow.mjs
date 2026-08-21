import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/docker-publish.yml", "utf8");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));

const invokedScripts = [...workflow.matchAll(/^\s+pnpm ([a-z][a-z0-9:_-]+)(?:\s|$)/gm)].map(
  (match) => match[1],
);
for (const script of invokedScripts) {
  if (script === "install" || script === "exec") continue;
  if (!manifest.scripts?.[script]) fail(`workflow invokes missing root script: ${script}`);
}

for (const forbidden of [
  "kahmyl/scry-backup",
  "BACKUP_IMAGE",
  "SCRY_BACKUP_IMAGE_REF",
  "verify:production-recovery",
  "COMPOSE_PROFILES: operations",
]) {
  if (workflow.includes(forbidden))
    fail(`beta publication retains backup dependency: ${forbidden}`);
}

for (const required of [
  "SCRY_DEPLOYMENT_TIER: beta",
  'COMPOSE_PROFILES: ""',
  "docker/build-push-action@v6",
  "docker compose -f compose.deploy.yml publish",
  "pnpm --filter @scry/api exec playwright install --with-deps chromium",
  "pnpm test:beta",
]) {
  if (!workflow.includes(required)) fail(`beta publication contract missing: ${required}`);
}

const qualificationIndex = workflow.indexOf("Boot and verify the candidate beta topology");
const loginIndex = workflow.indexOf("Log in to Docker Hub");
const publishIndex = workflow.indexOf("Build and publish the qualified Scry image");
if (!(qualificationIndex < loginIndex && loginIndex < publishIndex))
  fail("Docker publication must occur only after beta topology qualification");

const browserInstallIndex = workflow.indexOf(
  "pnpm --filter @scry/api exec playwright install --with-deps chromium",
);
const browserGateIndex = workflow.indexOf("pnpm verify:protected-interaction-conformance");
const betaTestsIndex = workflow.indexOf("pnpm test:beta");
if (!(browserInstallIndex < browserGateIndex && browserInstallIndex < betaTestsIndex))
  fail("the matching Playwright Chromium binary must be installed before browser-backed gates");

const environment = {
  ...process.env,
  SCRY_DEPLOYMENT_TIER: "beta",
  COMPOSE_PROFILES: "",
  POSTGRES_ARCHIVE_MODE: "off",
  SCRY_IMAGE_REF: `registry.invalid/scry@sha256:${"1".repeat(64)}`,
  SCRY_DOMAIN: "scry.invalid",
  SCRY_RELEASE_ID: "beta-verification",
  SCRY_SCHEMA_FINGERPRINT: "2".repeat(64),
  POSTGRES_PASSWORD: "verification",
  SCRY_SERVICE_TOKEN: "verification",
  SCRY_CREDENTIAL_ENCRYPTION_KEY: "3".repeat(64),
  VEIL_ADMISSION_KEY: "4".repeat(64),
  SUPABASE_URL: "https://example.invalid",
  SUPABASE_PUBLISHABLE_KEY: "verification",
};
const services = execFileSync(
  "docker",
  ["compose", "-f", "compose.deploy.yml", "config", "--services"],
  { env: environment, encoding: "utf8" },
)
  .trim()
  .split("\n");

for (const required of ["postgres", "redis", "migrate", "api", "worker", "mcp", "web", "caddy"]) {
  if (!services.includes(required)) fail(`beta stack omits core service: ${required}`);
}
for (const service of services) {
  if (/backup|restore-drill|prometheus|alertmanager/.test(service))
    fail(`beta stack unexpectedly enables operations service: ${service}`);
}

process.stdout.write(
  `Docker beta publication verified: ${invokedScripts.length} root scripts exist; ${services.length} core services; no backup image dependency.\n`,
);

function fail(message) {
  console.error(`Docker beta publication verification failed: ${message}`);
  process.exit(1);
}
