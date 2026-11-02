import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const fixture = fileURLToPath(
  new URL("../../../apps/api/test/deployed-browser-fixture.mjs", import.meta.url),
);
const visualReview = process.env.SCRY_ASSURANCE_VISUAL_REVIEW === "true";
// Read the fixture before provisioning anything; it is not shipped in the image.
if (!readFileSync(fixture, "utf8").includes("DEPLOYED_BASELINE_BROWSER_PASS"))
  throw new Error("SCRY_DEPLOYED_FIXTURE_MISSING");
writeFileSync(
  override,
  JSON.stringify({
    services: {
      api: { environment: { API_CORS_ORIGINS: "http://web:3000" } },
      web: { environment: { SCRY_PUBLIC_API_BASE_URL: "http://api:4000/api" } },
      fixture: {
        image,
        command: ["node", "/tmp/deployed-browser-fixture.mjs", "serve"],
        volumes: [
          {
            type: "bind",
            source: fixture,
            target: "/tmp/deployed-browser-fixture.mjs",
            read_only: true,
          },
          ...["browser-login-fixture.mjs", "deployed-native-browser.mjs"].map((filename) => ({
            type: "bind",
            source: path.join(root, "apps/api/test", filename),
            target: "/tmp/" + filename,
            read_only: true,
          })),
          // This fresh, fictional fixture may hold one exact admitted object to
          // qualify public failure closure. Never mount customer evidence here.
          "artifacts:/evidence",
        ],
        ...(visualReview ? { ports: ["127.0.0.1::8080"] } : {}),
        environment: {
          FIXTURE_DATABASE_URL: "postgres://scry:isolated-smoke-only@postgres:5432/scry_smoke",
          SCRY_FIXTURE_REVIEW: visualReview ? "true" : "false",
          SCRY_FIXTURE_SERVICE_TOKEN: "isolated-smoke-service-only",
        },
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
let reviewCancelled = false;
// Keep Node alive long enough to enter finally when the runner terminates its
// process group; Docker's children still receive the same cancellation signal.
const interrupted = () => {
  reviewCancelled = true;
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
    [...compose, "exec", "-T", "fixture", "node", "/tmp/deployed-browser-fixture.mjs", "exercise"],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  if (!output.includes("DEPLOYED_NATIVE_AUTHENTICATION_PASS"))
    throw new Error("SCRY_DEPLOYED_BROWSER_NOT_EXERCISED");
  if (!output.includes("DEPLOYED_AUTHENTICATED_DASHBOARD_PASS"))
    throw new Error("SCRY_DEPLOYED_DASHBOARD_NOT_EXERCISED");
  const visualProof = path.join(root, "artifacts", "assurance", `dashboard-${suffix}`);
  mkdirSync(visualProof, { recursive: true, mode: 0o700 });
  run([...compose, "cp", "fixture:/evidence/qualification-ui/.", visualProof]);
  for (const filename of [
    "native-login-desktop.png",
    "native-login-mobile.png",
    "unavailable-desktop.png",
    "unavailable-mobile.png",
  ])
    if (
      !readFileSync(path.join(visualProof, filename))
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("SCRY_DEPLOYED_DASHBOARD_IMAGE_MISSING");
  process.stdout.write(`Authenticated dashboard visual proof: ${visualProof}\n`);
  if (visualReview) {
    const binding = run([...compose, "port", "fixture", "8080"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
    if (!/^127\.0\.0\.1:[0-9]+$/.test(binding)) throw new Error("SCRY_REVIEW_BINDING_INVALID");
    const reviewPath = output.match(
      /DASHBOARD_REVIEW_PATH=(\/dashboard\/runs\/[a-f0-9-]{36})/u,
    )?.[1];
    if (!reviewPath) throw new Error("SCRY_REVIEW_PATH_MISSING");
    const done = path.join(directory, "review.done");
    process.stdout.write(
      `DASHBOARD_REVIEW_URL=http://${binding}${reviewPath}\nDASHBOARD_REVIEW_DONE_FILE=${done}\n`,
    );
    const deadline = Date.now() + 300000;
    while (!existsSync(done) && !reviewCancelled && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  run([
    ...compose,
    "exec",
    "-T",
    "api",
    "node",
    "--eval",
    "const fs=require('node:fs'); for(const p of ['packages/assurance','packages/executor','packages/policy','packages/observability','apps/agent-lab','apps/api/migrations','node_modules/typescript']) if(fs.existsSync(p)) process.exit(1); if(!fs.existsSync('scripts/operations/supabase-activity.mjs')) process.exit(1)",
  ]);
  process.stdout.write(
    "Isolated deployed native baseline passed: current MCP tools, rejected and successful split-origin authentication, POST profile read, session reload/logout, exact-action replay exclusion, unapproved-origin refusal, protected input, decoded continuous MP4, scoped media/report and signed-in desktop/mobile dashboard; no production Assurance dependency.\n",
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
