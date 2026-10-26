import { fileURLToPath as qualificationFilePath } from "node:url";
process.chdir(qualificationFilePath(new URL("../../../", import.meta.url)));
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
const deployScript = resolve(root, "scripts/deploy-server-release.sh");
const workflow = readFileSync(resolve(root, ".github/workflows/deploy-server.yml"), "utf8");
const compose = readFileSync(resolve(root, "compose.deploy.yml"), "utf8");

for (const required of [
  "workflow_dispatch:",
  "concurrency:",
  "cancel-in-progress: false",
  "environment:",
  "SCRY_DEPLOY_SSH_KEY",
  "SCRY_DEPLOY_KNOWN_HOSTS",
  "docker.io/kahmyl/scry:sha-$QUALIFIED_SHA",
  "scripts/deploy-server-release.sh",
  "^[A-Za-z_][A-Za-z0-9_-]*$",
]) {
  assert.ok(workflow.includes(required), `deployment workflow is missing ${required}`);
}

for (const service of ["caddy", "web"])
  assert.match(
    serviceSection(service),
    /healthcheck:/,
    `${service} requires an explicit deployment health check`,
  );

const previousRelease = "1".repeat(40);
const candidateRelease = "2".repeat(40);
const previousImage = `docker.io/kahmyl/scry@sha256:${"c".repeat(64)}`;
const candidateImage = `docker.io/kahmyl/scry@sha256:${"d".repeat(64)}`;

const success = runScenario("success");
assert.equal(success.status, 0, success.stderr);
assert.match(success.stdout, /is healthy and active/);
assertInOrder(success.log, [
  "stop -t 30 caddy",
  "pg_dump",
  "run --rm --no-deps migrate",
  "up -d --no-deps --force-recreate --wait",
  "exec -T api wget",
  "run --rm --no-deps --entrypoint caddy caddy validate",
]);
assert.match(success.state, new RegExp(`CURRENT_RELEASE_ID=${candidateRelease}`));
assert.match(success.state, new RegExp(`CURRENT_IMAGE_REF=${candidateImage}`));

const bootstrap = runScenario("running-release-bootstrap", { BOOTSTRAP: "true" });
assert.equal(bootstrap.status, 0, bootstrap.stderr);
assert.match(
  bootstrap.stdout,
  new RegExp(`Bootstrapped rollback metadata from running release ${previousRelease}`),
);
assert.match(bootstrap.log, /legacy-compose\.yaml/);
assert.match(bootstrap.state, new RegExp(`CURRENT_RELEASE_ID=${candidateRelease}`));

const multiFileBootstrap = runScenario("multi-file-running-release-bootstrap", {
  BOOTSTRAP: "true",
  MULTIPLE_CONFIGS: "true",
});
assert.equal(multiFileBootstrap.status, 0, multiFileBootstrap.stderr);
assert.match(multiFileBootstrap.log, /legacy-compose\.yaml/);
assert.match(multiFileBootstrap.log, /legacy-override\.yaml/);

const defaultFileBootstrap = runScenario("default-file-running-release-bootstrap", {
  BOOTSTRAP: "true",
  OMIT_CONFIG_LABEL: "true",
});
assert.equal(defaultFileBootstrap.status, 0, defaultFileBootstrap.stderr);
assert.match(defaultFileBootstrap.log, /compose\.yaml/);

const replay = runScenario("replay", { SAME_RELEASE: "true" });
assert.equal(replay.status, 0, replay.stderr);
assert.match(replay.stdout, /already healthy; deployment replay completed without interruption/);
assert.ok(!replay.log.includes("stop -t 30 caddy"));
assert.ok(!replay.log.includes("pg_dump"));
assert.ok(!replay.log.includes("run --rm --no-deps migrate"));

const active = runScenario("active", { ACTIVE_WORK: "2" });
assert.notEqual(active.status, 0);
assert.match(active.stderr, /deployment refused because 2 browser work item/);
assert.ok(
  !active.log.includes("pg_dump"),
  "active-work refusal must occur before backup or migration",
);
assert.ok(!active.log.includes("run --rm --no-deps migrate"));
assert.ok(active.log.includes("start caddy"), "the previous public entrypoint must be restored");

const migrationFailure = runScenario("migration-failure", { FAIL_MIGRATE: "true" });
assert.notEqual(migrationFailure.status, 0);
assert.match(migrationFailure.stderr, /beginning recovery/);
assertInOrder(migrationFailure.log, [
  "pg_dump",
  "run --rm --no-deps migrate",
  "dropdb",
  "createdb",
  "pg_restore",
  `SCRY_RELEASE_ID=${previousRelease}`,
]);
assert.match(migrationFailure.state, new RegExp(`CURRENT_RELEASE_ID=${previousRelease}`));

const recoveryFailure = runScenario("recovery-failure", {
  FAIL_MIGRATE: "true",
  FAIL_RESTORE: "true",
});
assert.equal(recoveryFailure.status, 90);
assert.match(recoveryFailure.stderr, /CRITICAL: automatic recovery did not complete/);
const afterRestoreFailure = recoveryFailure.log.slice(recoveryFailure.log.indexOf("pg_restore"));
assert.ok(
  !afterRestoreFailure.includes(`SCRY_RELEASE_ID=${previousRelease} `),
  "the previous application must not start against an unverified database restore",
);

const caddyValidationFailure = runScenario("caddy-validation-failure", {
  FAIL_CADDY_VALIDATE: "true",
});
assert.notEqual(caddyValidationFailure.status, 0);
assert.match(caddyValidationFailure.stderr, /beginning recovery/);
assertInOrder(caddyValidationFailure.log, [
  "run --rm --no-deps migrate",
  "run --rm --no-deps --entrypoint caddy caddy validate",
  "dropdb",
  "pg_restore",
  `SCRY_RELEASE_ID=${previousRelease}`,
]);

// Compose CLI -t overrides the manifest, including when stopping a previous
// release whose retained manifest predates the current worker grace period.
const workerGrace = Number(serviceSection("worker").match(/stop_grace_period:\s*(\d+)s/)?.[1]);
assert.ok(Number.isSafeInteger(workerGrace) && workerGrace >= 60);
for (const scenario of [
  success,
  bootstrap,
  migrationFailure,
  recoveryFailure,
  caddyValidationFailure,
]) {
  const stops = scenario.log.split("\n").filter((line) => /\bstop\b.*\bworker\b/.test(line));
  assert.ok(stops.length > 0, "scenario must actually exercise a worker stop");
  for (const line of stops) {
    const timeout = Number(line.match(/\bstop -t (\d+)\b/)?.[1]);
    assert.ok(
      timeout >= workerGrace,
      "deployment and rollback must preserve the worker manifest grace",
    );
  }
}

process.stdout.write(
  "Server deployment controller verified: success, no-op replay, active-work refusal, migration rollback, Caddy-validation rollback, and recovery-failure fencing.\n",
);

function runScenario(name, additions = {}) {
  const fixture = mkdtempSync(join(tmpdir(), `scry-deploy-${name}-`));
  const deployDir = join(fixture, "deploy");
  const stateRoot = join(deployDir, ".scry-deploy");
  const binDir = join(fixture, "bin");
  mkdirSync(join(stateRoot, "releases", previousRelease), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const envFile = join(deployDir, ".env");
  const previousCompose = join(stateRoot, "releases", previousRelease, "compose.yml");
  const incomingCompose = join(fixture, "candidate-compose.yml");
  const logFile = join(fixture, "docker.log");
  const bootstrap = additions.BOOTSTRAP === "true";
  const sameRelease = additions.SAME_RELEASE === "true";
  const savedRelease = sameRelease ? candidateRelease : previousRelease;
  const savedImage = sameRelease ? candidateImage : previousImage;
  const discoveredCompose = join(deployDir, "legacy-compose.yaml");
  const discoveredOverride = join(deployDir, "legacy-override.yaml");
  const fallbackCompose = join(deployDir, "compose.yaml");
  const discoveredComposeFiles =
    additions.MULTIPLE_CONFIGS === "true"
      ? `${discoveredCompose},${discoveredOverride}`
      : discoveredCompose;
  writeFileSync(
    envFile,
    [
      "SCRY_DEPLOYMENT_TIER=staging",
      "SCRY_DATABASE_NAME=scry_existing",
      "SCRY_DOMAIN=scry.example.test",
      "POSTGRES_PASSWORD=test-only",
    ].join("\n"),
    { mode: 0o600 },
  );
  chmodSync(envFile, 0o600);
  writeFileSync(previousCompose, "services: {}\n");
  writeFileSync(discoveredCompose, "services: {}\n");
  writeFileSync(discoveredOverride, "services: {}\n");
  writeFileSync(fallbackCompose, "services: {}\n");
  writeFileSync(incomingCompose, "services: {}\n");
  if (!bootstrap)
    writeFileSync(
      join(stateRoot, "current.env"),
      [
        `CURRENT_RELEASE_ID=${savedRelease}`,
        `CURRENT_IMAGE_REF=${savedImage}`,
        `CURRENT_COMPOSE_FILE=${previousCompose}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  writeExecutable(join(binDir, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(join(binDir, "stat"), "#!/usr/bin/env bash\nprintf '600\\n'\n");
  writeExecutable(
    join(binDir, "docker"),
    `#!/usr/bin/env bash
set -u
printf 'SCRY_RELEASE_ID=%s %s\\n' "\${SCRY_RELEASE_ID:-}" "$*" >>"$MOCK_DOCKER_LOG"
args="$*"
if [[ "$args" == "compose version --short" ]]; then printf '2.40.0\\n'; exit 0; fi
if [[ "$args" == ps\\ -q* ]]; then [[ "\${BOOTSTRAP:-false}" == true ]] && printf 'existing-api\\n'; exit 0; fi
if [[ "$args" == *"range .Config.Env"* ]]; then printf 'SCRY_RELEASE_ID=%s\\n' "$PREVIOUS_RELEASE"; exit 0; fi
if [[ "$args" == *".Config.Image"* ]]; then printf '%s\\n' "$PREVIOUS_IMAGE"; exit 0; fi
if [[ "$args" == *"com.docker.compose.project.config_files"* ]]; then [[ "\${OMIT_CONFIG_LABEL:-false}" == true ]] || printf '%s\\n' "$DISCOVERED_COMPOSE"; exit 0; fi
if [[ "$args" == *"com.docker.compose.project.working_dir"* ]]; then printf '%s\\n' "$DEPLOY_DIR"; exit 0; fi
if [[ "$args" == *"index .RepoDigests 0"* ]]; then printf '%s\\n' "$CANDIDATE_IMAGE"; exit 0; fi
if [[ "$args" == *"org.scry.release-id"* ]]; then printf '%s\\n' "$CANDIDATE_RELEASE"; exit 0; fi
if [[ "$args" == *"SELECT 1 FROM pg_database"* ]]; then printf '1\\n'; exit 0; fi
if [[ "$args" == *"browser_execution_sessions"* ]]; then printf '%s\\n' "\${ACTIVE_WORK:-0}"; exit 0; fi
if [[ "$args" == *"pg_dump"* ]]; then printf 'mock-database-dump\\n'; exit 0; fi
if [[ "$args" == *"printenv SCRY_RELEASE_ID"* ]]; then printf '%s\\n' "$SCRY_RELEASE_ID"; exit 0; fi
if [[ "$args" == *"run --rm --no-deps migrate"* && "\${FAIL_MIGRATE:-false}" == true ]]; then exit 55; fi
if [[ "$args" == *"pg_restore"* && "\${FAIL_RESTORE:-false}" == true ]]; then exit 66; fi
if [[ "$args" == *"run --rm --no-deps --entrypoint caddy caddy validate"* && "\${FAIL_CADDY_VALIDATE:-false}" == true ]]; then exit 77; fi
cat >/dev/null 2>&1 || true
exit 0
`,
  );
  const result = spawnSync(
    "bash",
    [deployScript, deployDir, candidateRelease, candidateImage, incomingCompose],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        MOCK_DOCKER_LOG: logFile,
        CANDIDATE_IMAGE: candidateImage,
        CANDIDATE_RELEASE: candidateRelease,
        PREVIOUS_RELEASE: previousRelease,
        PREVIOUS_IMAGE: previousImage,
        DISCOVERED_COMPOSE: discoveredComposeFiles,
        DEPLOY_DIR: deployDir,
        ...additions,
      },
    },
  );
  return {
    ...result,
    log: readFileSync(logFile, "utf8"),
    state: readFileSync(join(stateRoot, "current.env"), "utf8"),
  };
}

function assertInOrder(source, fragments) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor + 1);
    assert.ok(next > cursor, `expected ${fragment} after offset ${cursor}\n${source}`);
    cursor = next;
  }
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function serviceSection(service) {
  const start = compose.indexOf(`\n  ${service}:\n`);
  assert.ok(start >= 0, `missing Compose service ${service}`);
  const remainder = compose.slice(start + 1);
  const nextService = remainder.slice(3).search(/^  [A-Za-z0-9-]+:\n/m);
  return nextService < 0 ? remainder : remainder.slice(0, nextService + 3);
}
