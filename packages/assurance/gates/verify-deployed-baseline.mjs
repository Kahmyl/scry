import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
process.chdir(root);
const suffix = randomUUID();
const project = `scry-baseline-smoke-${suffix}`;
const image = `scry-baseline-smoke:${suffix}`;
const directory = mkdtempSync(path.join(os.tmpdir(), "scry-deployed-baseline-"));
const override = path.join(directory, "fixture.json");
const fixture = fileURLToPath(new URL("./fixtures/deployed-browser.mjs", import.meta.url));
// Read the fixture before provisioning anything; it is not shipped in the image.
if (!readFileSync(fixture, "utf8").includes("DEPLOYED_BASELINE_BROWSER_PASS"))
  throw new Error("SCRY_DEPLOYED_FIXTURE_MISSING");
writeFileSync(
  override,
  JSON.stringify({
    services: {
      fixture: {
        image,
        command: ["node", "/tmp/deployed-browser.mjs", "serve"],
        volumes: [
          { type: "bind", source: fixture, target: "/tmp/deployed-browser.mjs", read_only: true },
          "artifacts:/evidence:ro",
        ],
        healthcheck: {
          test: [
            "CMD",
            "node",
            "--eval",
            "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          interval: "1s",
          timeout: "3s",
          retries: 20,
        },
      },
    },
  }),
  { mode: 0o600 },
);
const env = {
  ...process.env,
  SCRY_DEPLOYMENT_TIER: "beta",
  COMPOSE_PROFILES: "",
  SCRY_IMAGE_REF: image,
  SCRY_RELEASE_ID: "isolated-baseline-smoke",
  SCRY_DOMAIN: "scry.invalid",
  SCRY_DATABASE_NAME: "scry_smoke",
  POSTGRES_PASSWORD: "isolated-smoke-only",
  SCRY_SERVICE_TOKEN: "isolated-smoke-service-only",
  SUPABASE_URL: "http://fixture:8080",
  SUPABASE_PUBLISHABLE_KEY: "isolated-fixture-only",
  SCRY_BROWSER_REQUIRE_ACTIVATED_CUTOVER: "false",
  SCRY_BROWSER_PROTECTED_KEY_ID: "fixture-key",
  SCRY_BROWSER_PROTECTED_KEYS_JSON: JSON.stringify({
    "fixture-key": Buffer.alloc(32, 7).toString("base64"),
  }),
  POSTGRES_ARCHIVE_MODE: "off",
};
const compose = [
  "compose",
  "--project-name",
  project,
  "-f",
  path.join(root, "compose.deploy.yml"),
  "-f",
  override,
];
const run = (args, options = {}) =>
  execFileSync("docker", args, { env, cwd: root, stdio: "inherit", timeout: 180_000, ...options });
let built = false;
// Keep Node alive long enough to enter finally when the runner terminates its
// process group; Docker's children still receive the same cancellation signal.
const interrupted = () => {
  process.exitCode = 130;
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
try {
  run(["build", "-t", image, "."], { timeout: 600_000 });
  built = true;
  run([
    "run",
    "--rm",
    "-e",
    "SCRY_DEPLOYMENT_TIER=staging",
    image,
    "node",
    "scripts/verify-deployment-preflight.mjs",
  ]);
  run([
    ...compose,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "120",
    "postgres",
    "redis",
    "migrate",
    "api",
    "worker",
    "mcp",
    "web",
    "fixture",
  ]);
  const output = run(
    [...compose, "exec", "-T", "fixture", "node", "/tmp/deployed-browser.mjs", "exercise"],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  if (!output.includes("DEPLOYED_BASELINE_BROWSER_PASS"))
    throw new Error("SCRY_DEPLOYED_BROWSER_NOT_EXERCISED");
  run([
    ...compose,
    "exec",
    "-T",
    "api",
    "node",
    "--eval",
    "const fs=require('node:fs'); for(const p of ['packages/assurance','packages/executor','packages/policy','packages/observability','apps/agent-lab','apps/api/migrations','node_modules/typescript']) if(fs.existsSync(p)) process.exit(1)",
  ]);
  process.stdout.write(
    "Isolated deployed baseline passed: authenticated API/MCP, real Chromium, protected fill, evidence closure, report, workspace/session refusal, and web; no production Assurance dependency.\n",
  );
} finally {
  let cleanupFailed = false;
  try {
    run([...compose, "down", "--volumes", "--remove-orphans"], { timeout: 60_000 });
  } catch {
    cleanupFailed = true;
  }
  try {
    if (built) run(["image", "rm", image], { timeout: 60_000 });
  } catch {
    cleanupFailed = true;
  }
  rmSync(directory, { recursive: true, force: true });
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
  if (cleanupFailed) throw new Error("SCRY_DEPLOYED_FIXTURE_CLEANUP_FAILED");
}
