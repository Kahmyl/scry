import { fileURLToPath as qualificationFilePath } from "node:url";
process.chdir(qualificationFilePath(new URL("../../../", import.meta.url)));
import { execFileSync, spawnSync } from "node:child_process";

const base = {
  ...process.env,
  SCRY_IMAGE_REF: "registry.invalid/scry@sha256:" + "1".repeat(64),
  SCRY_DOMAIN: "staging.scry.invalid",
  SCRY_RELEASE_ID: "verification",
  SCRY_DATABASE_NAME: "scry_verification",
  POSTGRES_PASSWORD: "verification",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "verification",
  SCRY_SERVICE_TOKEN: "verification",
  SCRY_BROWSER_PROTECTED_KEY_ID: "browser-key-1",
  SCRY_BROWSER_PROTECTED_KEYS_JSON: JSON.stringify({
    "browser-key-1": Buffer.alloc(32, 7).toString("base64"),
  }),
};

const staging = { ...base, SCRY_DEPLOYMENT_TIER: "staging", COMPOSE_PROFILES: "" };
runPreflight(staging);
const stagingServices = renderServices(staging);
for (const service of ["api", "worker", "mcp", "web", "postgres", "redis"])
  if (!stagingServices.includes(service))
    throw new Error(`staging core service missing: ${service}`);
for (const service of ["postgres-base-backup", "restore-drill", "prometheus", "alertmanager"])
  if (stagingServices.includes(service)) throw new Error(`staging unexpectedly enables ${service}`);

const production = {
  ...base,
  SCRY_DEPLOYMENT_TIER: "production",
  COMPOSE_PROFILES: "operations",
  SCRY_BACKUP_IMAGE_REF: "registry.invalid/scry-backup@sha256:" + "3".repeat(64),
  RESTIC_REPOSITORY: "s3:https://backup.invalid/scry",
  RESTIC_PASSWORD: "verification",
  SCRY_ALERT_WEBHOOK_URL: "https://alerts.invalid/scry",
  POSTGRES_ARCHIVE_MODE: "on",
};
runPreflight(production);
const productionServices = renderServices(production);
for (const service of ["postgres-base-backup", "restore-drill", "prometheus", "alertmanager"])
  if (!productionServices.includes(service))
    throw new Error(`production operations service missing: ${service}`);

const invalid = spawnSync("node", ["scripts/verify-deployment-preflight.mjs"], {
  env: { ...base, SCRY_DEPLOYMENT_TIER: "production", COMPOSE_PROFILES: "" },
});
if (invalid.status === 0) throw new Error("production accepted disabled operations");

console.log(
  "Deployment tiers verified: staging core-only, production operations-enabled, and invalid production refused.",
);

function runPreflight(env) {
  execFileSync("node", ["scripts/verify-deployment-preflight.mjs"], { env, stdio: "pipe" });
}

function renderServices(env) {
  return execFileSync("docker", ["compose", "-f", "compose.deploy.yml", "config", "--services"], {
    env,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
}
