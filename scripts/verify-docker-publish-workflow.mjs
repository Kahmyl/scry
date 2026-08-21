import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderComposeOci } from "./render-compose-oci.mjs";

const workflow = readFileSync(".github/workflows/docker-publish.yml", "utf8");

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

const qualificationIndex = workflow.indexOf("Boot and smoke-test the candidate beta topology");
const loginIndex = workflow.indexOf("Log in to Docker Hub");
const publishIndex = workflow.indexOf("Build and publish the Scry beta image");
if (!(qualificationIndex < loginIndex && loginIndex < publishIndex))
  fail("Docker publication must occur only after the candidate beta topology smoke test");

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
  `Docker beta publication verified: build-and-smoke policy; ${services.length} core services; no test or backup image dependency.\n`,
);

function fail(message) {
  console.error(`Docker beta publication verification failed: ${message}`);
  process.exit(1);
}
