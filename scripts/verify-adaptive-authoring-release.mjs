import { spawnSync } from "node:child_process";

const strict = process.env.SCRY_RELEASE_CORPUS_GATE_ENABLED === "true";
const databaseUrl = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
const vitractEnabled = process.env.SCRY_VITRACT_PREVIEW_E2E === "true";

if (strict && !databaseUrl)
  fail("SCRY_AUTHORING_TEST_DATABASE_URL is required for the release gate");
if (strict && !vitractEnabled)
  fail("SCRY_VITRACT_PREVIEW_E2E=true is required for the release gate");

run([
  "--filter",
  "@scry/praxis",
  "exec",
  "vitest",
  "run",
  "test/malformed-control-corpus.test.ts",
  "test/candidate-resolution.test.ts",
  "test/risk-policy.test.ts",
]);
run([
  "--filter",
  "@scry/executor",
  "exec",
  "vitest",
  "run",
  "test/protected-acquisition-adapters.test.ts",
  "test/protected-transaction-coordinator.test.ts",
  "test/probe-veil-boundary.test.ts",
  "test/vitract-preview.e2e.test.ts",
]);
run([
  "--filter",
  "@scry/veil",
  "exec",
  "vitest",
  "run",
  "test/clipboard-collector.test.ts",
  "test/runtime-session.test.ts",
  "test/channel-collector.test.ts",
]);
run([
  "--filter",
  "@scry/api",
  "exec",
  "vitest",
  "run",
  "test/transcript-compiler.test.ts",
  "test/authentication-authoring.integration.test.ts",
  "test/calibration-runner.test.ts",
  "test/vitract-authoring-vertical.test.ts",
]);
if (databaseUrl) {
  run(["--filter", "@scry/api", "exec", "vitest", "run", "test/authoring.integration.test.ts"]);
}
if (strict) {
  run(["campaign:praxis:public-apps"]);
  run(["campaign:veil:adversarial"]);
  run(["campaign:veil:public-apps"]);
}

function run(args) {
  const result = spawnSync("pnpm", args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
