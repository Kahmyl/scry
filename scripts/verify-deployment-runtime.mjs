import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = mkdtempSync(join(tmpdir(), "scry-deployment-runtime-"));
const envFile = join(fixture, "deploy.env");
const project = `scry-caddy-contract-${process.pid}-${Date.now()}`;
const schemaFingerprint = execFileSync("node", ["scripts/schema-fingerprint.mjs"], {
  encoding: "utf8",
}).trim();

writeFileSync(
  envFile,
  [
    "SCRY_DEPLOYMENT_TIER=staging",
    "COMPOSE_PROFILES=",
    `SCRY_IMAGE_REF=registry.invalid/scry@sha256:${"1".repeat(64)}`,
    "SCRY_DOMAIN=scry.invalid",
    `SCRY_RELEASE_ID=${"2".repeat(40)}`,
    `SCRY_SCHEMA_FINGERPRINT=${schemaFingerprint}`,
    "POSTGRES_PASSWORD=verification-only",
    "SUPABASE_URL=https://example.supabase.co",
    "SUPABASE_PUBLISHABLE_KEY=verification-only",
    "SCRY_SERVICE_TOKEN=verification-only",
    "BROWSER_V2_PROTECTED_KEY_VERSION=verification-v1",
    `BROWSER_V2_PROTECTED_KEYS_JSON={"verification-v1":"${Buffer.alloc(32, 7).toString("base64")}"}`,
  ].join("\n"),
  { mode: 0o600 },
);

const composeArguments = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  envFile,
  "-f",
  "compose.deploy.yml",
];

try {
  execFileSync(
    "docker",
    [
      ...composeArguments,
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "caddy",
      "caddy",
      "validate",
      "--config",
      "/etc/caddy/Caddyfile",
    ],
    { stdio: "inherit" },
  );
  console.log(
    "Deployment runtime verified: the real Caddy image accepts the rendered configuration.",
  );
} finally {
  try {
    execFileSync("docker", [...composeArguments, "down", "-v", "--remove-orphans"], {
      stdio: "ignore",
    });
  } catch {
    // The validation command can fail before Compose creates project resources.
  }
  rmSync(fixture, { recursive: true, force: true });
}
