import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderComposeOci } from "./render-compose-oci.mjs";

const workflow = readFileSync(".github/workflows/docker-publish.yml", "utf8");
const databaseQualification = readFileSync(".github/workflows/qualification-database.yml", "utf8");
const fastQualification = readFileSync(".github/workflows/qualification-fast.yml", "utf8");
const dockerfile = readFileSync("Dockerfile", "utf8");
const developmentDockerfiles = ["docker/Dockerfile.dev", "docker/Dockerfile.worker"].map(
  (file) => ({ file, source: readFileSync(file, "utf8") }),
);
const dockerignore = readFileSync(".dockerignore", "utf8");
const deployCompose = readFileSync("compose.deploy.yml", "utf8");
const apiPackage = JSON.parse(readFileSync("apps/api/package.json", "utf8"));

for (const retiredWorkflow of [
  ".github/workflows/praxis-verification.yml",
  ".github/workflows/veil-verification.yml",
]) {
  if (existsSync(retiredWorkflow))
    fail(`retired pre-reset qualification workflow remains active: ${retiredWorkflow}`);
}

for (const forbidden of [
  "kahmyl/scry-backup",
  "BACKUP_IMAGE",
  "SCRY_BACKUP_IMAGE_REF",
  "verify:production-recovery",
  "COMPOSE_PROFILES: operations",
  "pnpm ",
  "vitest",
  "typecheck",
  "test:beta",
  "verify:adaptive-authoring-release",
]) {
  if (workflow.includes(forbidden))
    fail(`beta publication retains excluded pre-publication dependency: ${forbidden}`);
}

for (const required of [
  "workflow_run:",
  "Scry required qualification",
  "qualified_sha:",
  "publication_reason:",
  "residual_risk_acknowledgement:",
  "publish_latest:",
  "github.event.workflow_run.head_sha || inputs.qualified_sha",
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'",
  "github.event.workflow_run.head_branch == 'main'",
  "startsWith(github.event.workflow_run.head_branch, 'v')",
  "Verify manual publication authority",
  "Automated publication requires qualification from main or a semantic version tag.",
  "^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$",
  "I_ACKNOWLEDGE_RESIDUAL_RISK",
  "Record publication audit evidence",
  "artifacts/publication-audit.json",
  "Upload publication audit evidence",
  "sha-${{ env.QUALIFIED_SHA }}",
  "env.PUBLISH_LATEST == 'true'",
  "SCRY_DEPLOYMENT_TIER: beta",
  'COMPOSE_PROFILES: ""',
  "docker/build-push-action@v6",
  'node scripts/render-compose-oci.mjs "$RUNNER_TEMP/scry-compose-oci.yml"',
  'docker compose -f "$SCRY_COMPOSE_FILE" publish',
  "node scripts/schema-fingerprint.mjs",
  "Boot and smoke-test the candidate beta topology",
]) {
  if (!workflow.includes(required)) fail(`beta publication contract missing: ${required}`);
}

for (const forbidden of [
  "github.event.workflow_run.head_sha || github.sha",
  "github.ref == 'refs/heads/main'",
]) {
  if (workflow.includes(forbidden))
    fail(`beta publication retains ambiguous publication authority: ${forbidden}`);
}

for (const required of [
  "BROWSER_V2_SCHEMA_CONFIRM: CREATE_EMPTY_V2",
  "test/browser-v2-scope-integrity.integration.test.ts",
  "pnpm verify:browser-v2-cutover",
]) {
  if (!databaseQualification.includes(required))
    fail(`database qualification outcome contract missing: ${required}`);
}

if (!fastQualification.includes("artifacts/verification-ci-unit-results.json"))
  fail("fast qualification artifact omits CI unit results");

const runtimePackages = [
  "browser-runtime",
  "chronicle",
  "contracts",
  "executor",
  "observability",
  "policy",
  "praxis",
  "veil",
];

const workspaceManifests = [
  "apps/api/package.json",
  "apps/mcp/package.json",
  "apps/web/package.json",
  "packages/assurance/package.json",
  ...runtimePackages.map((packageName) => `packages/${packageName}/package.json`),
];

for (const { file, source } of developmentDockerfiles) {
  for (const manifest of workspaceManifests) {
    if (!source.includes(`COPY ${manifest} ${manifest}`))
      fail(`${file} dependency layer omits workspace manifest: ${manifest}`);
  }
}

if (apiPackage.dependencies?.["@scry/assurance"])
  fail("@scry/api must not classify Assurance as a production dependency");

if (apiPackage.devDependencies?.["@scry/assurance"] !== "workspace:*")
  fail("@scry/api must retain Assurance only as qualification/tooling dependency");

if (!dockerfile.includes("COPY packages/assurance/package.json packages/assurance/package.json"))
  fail("Docker dependency resolution must retain the Assurance workspace manifest");

if (/^COPY packages packages$/m.test(dockerfile))
  fail("Docker runtime image must not broadly copy every workspace package");

if (/^COPY packages\/assurance packages\/assurance$/m.test(dockerfile))
  fail("Docker runtime image must not ship Assurance implementation source");

for (const packageName of runtimePackages) {
  const copy = `COPY packages/${packageName} packages/${packageName}`;
  if (!dockerfile.includes(copy)) fail(`Docker runtime package source missing: ${packageName}`);
}

if (!dockerfile.includes("--store-dir /pnpm/store"))
  fail("pnpm cache mount exists but pnpm is not explicitly bound to it");

for (const ignored of ["**/test", "**/tests", "**/*.test.ts", "**/*.spec.ts"]) {
  if (!dockerignore.split(/\r?\n/).includes(ignored))
    fail(`Docker context does not exclude test-only source: ${ignored}`);
}

const fastStartupProbeCount = (deployCompose.match(/start_interval:\s*1s/g) ?? []).length;

if (fastStartupProbeCount < 4)
  fail(
    `deployment requires fast startup probes for postgres, redis, api, and mcp; found ${fastStartupProbeCount}`,
  );

for (const required of [
  'test: ["CMD-SHELL", "pg_isready -U scry -d ${SCRY_DATABASE_NAME:-scry_browser_v2}"]',
  'test: ["CMD", "redis-cli", "ping"]',
  'test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4000/api/v2/health"]',
  'test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4100/health"]',
]) {
  const index = deployCompose.indexOf(required);

  if (index < 0) fail(`deployment healthcheck missing: ${required}`);

  const section = deployCompose.slice(index, index + 300);

  if (!section.includes("start_interval: 1s"))
    fail(`deployment healthcheck lacks fast startup interval: ${required}`);

  if (!section.includes("interval: 5s"))
    fail(`deployment healthcheck changed steady-state interval: ${required}`);
}

for (const application of ["api", "mcp"]) {
  const manifest = JSON.parse(readFileSync(`apps/${application}/package.json`, "utf8"));

  if (!manifest.dependencies?.tsx)
    fail(`@scry/${application} production entrypoints require tsx as a runtime dependency`);

  if (manifest.devDependencies?.tsx)
    fail(`@scry/${application} must not classify production tsx as a dev dependency`);
}

if (!dockerfile.includes("FROM deps AS prod-deps"))
  fail("Docker runtime requires a dedicated production dependency stage");

if (!dockerfile.includes("pnpm install --prod --offline --frozen-lockfile --store-dir /pnpm/store"))
  fail(
    "production dependency stage must install only production dependencies from the cached store",
  );

for (const forbidden of [
  "COPY --from=deps /workspace/node_modules ./node_modules",
  "COPY --from=deps /workspace/apps ./apps",
  "COPY --from=deps /workspace/packages ./packages",
]) {
  if (dockerfile.includes(forbidden))
    fail(`runtime image still inherits full development dependencies: ${forbidden}`);
}

for (const required of [
  "COPY --from=prod-deps /workspace/node_modules ./node_modules",
  "COPY --from=prod-deps /workspace/apps ./apps",
  "COPY --from=prod-deps /workspace/packages ./packages",
  "COPY scripts/schema-fingerprint.mjs scripts/verify-deployment-preflight.mjs ./scripts/",
]) {
  if (!dockerfile.includes(required))
    fail(`runtime image does not inherit pruned production dependencies: ${required}`);
}

if (!workflow.includes("node scripts/verify-deployment-preflight.mjs"))
  fail("publication must execute the image-owned deployment preflight before publishing");

for (const forbidden of [
  'command: ["pnpm", "--filter", "@scry/api"',
  'command: ["pnpm", "--filter", "@scry/mcp"',
]) {
  if (deployCompose.includes(forbidden))
    fail(
      `production Compose must not require pnpm/Corepack during container startup: ${forbidden}`,
    );
}

for (const required of [
  '"apps/api/tsconfig.json",\n        "apps/api/src/browser-v2-main.ts"',
  '"apps/api/tsconfig.json",\n        "apps/api/src/browser-v2-worker.ts"',
  '"apps/api/tsconfig.json",\n        "apps/api/scripts/migrate-browser-v2.ts"',
  '"apps/mcp/tsconfig.json",\n        "apps/mcp/src/browser-v2-http.ts"',
]) {
  if (!deployCompose.includes(required))
    fail(`production Compose runtime command missing: ${required}`);
}

if (
  !dockerfile.includes(
    'CMD ["apps/api/node_modules/.bin/tsx", "--tsconfig", "apps/api/tsconfig.json", "apps/api/src/browser-v2-main.ts"]',
  )
)
  fail("Docker default runtime command must invoke app-local tsx directly");

if (!dockerfile.includes("COPY packages/browser-runtime packages/browser-runtime"))
  fail("Docker runtime must include the browser execution package");

const runnerSection = dockerfile.slice(dockerfile.indexOf(" AS runner"));

if (runnerSection.includes("RUN corepack enable"))
  fail("production runner must not initialize Corepack");

if (runnerSection.includes("PNPM_HOME"))
  fail("production runner must not carry pnpm runtime configuration");

const qualificationIndex = workflow.indexOf("Boot and smoke-test the candidate beta topology");
const loginIndex = workflow.indexOf("Log in to Docker Hub");
const publishIndex = workflow.indexOf("Publish the smoke-tested Scry beta image");
if (!(qualificationIndex < loginIndex && loginIndex < publishIndex))
  fail("Docker publication must occur only after the candidate beta topology smoke test");

const imageBuildCount = (workflow.match(/uses: docker\/build-push-action@v6/g) ?? []).length;
if (imageBuildCount !== 1)
  fail(`beta publication must build the application image exactly once; found ${imageBuildCount}`);

if (!workflow.includes("load: true"))
  fail("the single candidate image build must load the exact image used by smoke qualification");

if (workflow.includes("push: true"))
  fail("docker/build-push-action must not rebuild/push after smoke qualification");

for (const required of [
  "SOURCE_IMAGE: scry-beta-ci:${{ env.QUALIFIED_SHA }}",
  "PUBLISH_TAGS: ${{ steps.meta.outputs.tags }}",
  'docker tag "$SOURCE_IMAGE" "$tag"',
  'docker push "$tag"',
  'echo "digest=$published_digest" >> "$GITHUB_OUTPUT"',
  "${{ steps.publish-image.outputs.digest }}",
  "cache-to: type=gha,mode=max,scope=scry",
]) {
  if (!workflow.includes(required)) fail(`single-build publication contract missing: ${required}`);
}

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
  BROWSER_V2_PROTECTED_KEYS_JSON: JSON.stringify({
    "verification-v1": Buffer.alloc(32, 3).toString("base64"),
  }),
  BROWSER_V2_PROTECTED_KEY_VERSION: "verification-v1",
  BROWSER_V2_REQUIRE_ACTIVATED_CUTOVER: "false",
  SUPABASE_URL: "https://example.invalid",
  SUPABASE_PUBLISHABLE_KEY: "verification",
};
const temporaryDirectory = mkdtempSync(join(tmpdir(), "scry-compose-oci-verification-"));
const renderedPath = join(temporaryDirectory, "compose.yml");
let services;
try {
  const rendered = renderComposeOci(renderedPath);
  if (/^\s+file:\s+/m.test(rendered))
    fail("rendered OCI Compose model retains a local file-backed config");
  for (const configName of [
    "postgres_hba",
    "prometheus_config",
    "prometheus_rules",
    "blackbox_config",
  ]) {
    if (!rendered.includes(`  ${configName}:\n    content: |`))
      fail(`rendered OCI Compose model does not embed ${configName}`);
  }
  services = execFileSync("docker", ["compose", "-f", renderedPath, "config", "--services"], {
    env: environment,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  const resolvedModel = execFileSync("docker", ["compose", "-f", renderedPath, "config"], {
    env: { ...environment, COMPOSE_PROFILES: "operations" },
    encoding: "utf8",
  });
  const renderedFastStartupProbeCount = (resolvedModel.match(/start_interval:\s*1s/g) ?? []).length;

  if (renderedFastStartupProbeCount < 4)
    fail(
      `rendered OCI Compose model lost fast startup probes; found ${renderedFastStartupProbeCount}`,
    );
  if (!resolvedModel.includes("{{ $$labels.instance }}"))
    fail("rendered OCI Compose model did not preserve escaped Prometheus template variables");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

for (const required of ["postgres", "redis", "migrate", "api", "worker", "mcp", "web", "caddy"]) {
  if (!services.includes(required)) fail(`beta stack omits core service: ${required}`);
}
for (const service of services) {
  if (/backup|restore-drill|prometheus|alertmanager/.test(service))
    fail(`beta stack unexpectedly enables operations service: ${service}`);
}

process.stdout.write(
  `Docker beta publication verified: single-build smoke-and-publish policy; ${services.length} core services; no test or backup image dependency.\n`,
);

function fail(message) {
  console.error(`Docker beta publication verification failed: ${message}`);
  process.exit(1);
}
