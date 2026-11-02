import { fileURLToPath as qualificationFilePath } from "node:url";
process.chdir(qualificationFilePath(new URL("../../../", import.meta.url)));
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const fixture = mkdtempSync(join(tmpdir(), "scry-deployment-runtime-"));
const envFile = join(fixture, "deploy.env");
const project = `scry-caddy-contract-${process.pid}-${Date.now()}`;
writeFileSync(
  envFile,
  [
    "SCRY_DEPLOYMENT_TIER=staging",
    "COMPOSE_PROFILES=",
    `SCRY_IMAGE_REF=registry.invalid/scry@sha256:${"1".repeat(64)}`,
    "SCRY_DOMAIN=scry.invalid",
    `SCRY_RELEASE_ID=${"2".repeat(40)}`,
    "SCRY_DATABASE_NAME=scry_verification",
    "POSTGRES_PASSWORD=verification-only",
    "SUPABASE_URL=https://example.supabase.co",
    "SUPABASE_PUBLISHABLE_KEY=verification-only",
    "SCRY_SERVICE_TOKEN=verification-only",
    "SCRY_BROWSER_PROTECTED_KEY_ID=verification-key",
    `SCRY_BROWSER_PROTECTED_KEYS_JSON={"verification-key":"${Buffer.alloc(32, 7).toString("base64")}"}`,
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
  const render = (oauth) =>
    JSON.parse(
      execFileSync("docker", [...composeArguments, "config", "--format", "json"], {
        encoding: "utf8",
        env: {
          ...process.env,
          SCRY_OAUTH_ENABLED: String(oauth),
          SCRY_OAUTH_ISSUER: "https://scry.invalid/oauth",
          SCRY_OAUTH_RESOURCE: "https://scry.invalid/mcp",
          SCRY_OAUTH_COOKIE_KEYS_JSON: "fictional-cookie-render-value",
          SCRY_OAUTH_JWKS_JSON: "fictional-signing-render-value",
        },
      }),
    );
  const disabled = render(false);
  assert.equal(disabled.services.api.environment.SCRY_OAUTH_ENABLED, "false");
  assert.equal(disabled.services.mcp.environment.SCRY_OAUTH_ENABLED, "false");
  const enabled = render(true);
  for (const service of ["api", "mcp"]) {
    assert.equal(enabled.services[service].environment.SCRY_OAUTH_ENABLED, "true");
    assert.equal(
      enabled.services[service].environment.SCRY_OAUTH_RESOURCE,
      "https://scry.invalid/mcp",
    );
  }
  for (const key of ["SCRY_OAUTH_COOKIE_KEYS_JSON", "SCRY_OAUTH_JWKS_JSON"]) {
    assert.ok(enabled.services.api.environment[key]);
    for (const service of ["mcp", "web", "worker"])
      assert.equal(enabled.services[service].environment[key], undefined);
  }
  console.log(
    "OAuth deployment wiring verified: explicit activation, shared public scope, private keys only on API.",
  );
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
