const tier = process.env.SCRY_DEPLOYMENT_TIER ?? "staging";
const validTiers = new Set(["staging", "beta", "production"]);
if (!validTiers.has(tier)) fail("SCRY_DEPLOYMENT_TIER must be staging, beta, or production");

const profiles = new Set(
  (process.env.COMPOSE_PROFILES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const operationsEnabled = profiles.has("operations");

if (tier === "production" && !operationsEnabled)
  fail("production requires COMPOSE_PROFILES=operations");
if (tier === "production" && !/^.+@sha256:[a-f0-9]{64}$/.test(process.env.SCRY_IMAGE_REF ?? ""))
  fail("production requires SCRY_IMAGE_REF pinned by sha256 digest");

if (operationsEnabled) {
  requireValue("SCRY_BACKUP_IMAGE_REF");
  requireValue("RESTIC_REPOSITORY");
  requireValue("RESTIC_PASSWORD");
  requireValue("SCRY_ALERT_WEBHOOK_URL");
  if (process.env.POSTGRES_ARCHIVE_MODE !== "on")
    fail("operations requires POSTGRES_ARCHIVE_MODE=on");
  if (tier === "production" && !/^.+@sha256:[a-f0-9]{64}$/.test(process.env.SCRY_BACKUP_IMAGE_REF))
    fail("production requires SCRY_BACKUP_IMAGE_REF pinned by sha256 digest");
  if (tier === "production" && !/^https:\/\//.test(process.env.SCRY_ALERT_WEBHOOK_URL))
    fail("production requires an HTTPS SCRY_ALERT_WEBHOOK_URL");
}

const artifactProvider = process.env.ARTIFACT_STORAGE_PROVIDER ?? "local";
if (
  tier === "production" &&
  artifactProvider !== "local" &&
  process.env.ARTIFACT_STORE_VERSIONING_CONFIRMED !== "true"
)
  fail("production remote artifact storage requires ARTIFACT_STORE_VERSIONING_CONFIRMED=true");

console.log(
  `Deployment preflight passed: tier=${tier}, operations=${operationsEnabled ? "enabled" : "disabled"}, artifactProvider=${artifactProvider}.`,
);

function requireValue(name) {
  if (!process.env[name]?.trim()) fail(`${name} is required when operations are enabled`);
}

function fail(message) {
  console.error(`Deployment preflight failed: ${message}`);
  process.exit(1);
}
