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
for (const flag of ["SCRY_BROWSER_WORKFLOW_V1_ENABLED", "SCRY_BROWSER_WORKFLOW_V2_ENABLED"]) {
  if (process.env[flag] !== undefined && !["true", "false"].includes(process.env[flag]))
    fail(`${flag} must be true or false`);
}
if (process.env.SCRY_BROWSER_WORKFLOW_V2_ENABLED === "true") {
  let origins;
  try {
    origins = JSON.parse(process.env.SCRY_BROWSER_PRIVATE_NETWORK_ORIGINS ?? "[]");
  } catch {
    fail("SCRY_BROWSER_PRIVATE_NETWORK_ORIGINS must be a JSON array of explicit HTTP(S) origins");
  }
  if (
    !Array.isArray(origins) ||
    origins.length > 20 ||
    origins.some((value) => {
      try {
        const u = new URL(value);
        return (
          typeof value !== "string" ||
          u.origin !== value ||
          !["http:", "https:"].includes(u.protocol)
        );
      } catch {
        return true;
      }
    })
  )
    fail("SCRY_BROWSER_PRIVATE_NETWORK_ORIGINS must contain at most 20 exact HTTP(S) origins");
}

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
