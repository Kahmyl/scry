import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const startedAt = new Date().toISOString();
const started = performance.now();

const databaseUrl =
  process.env.SCRY_AUTHORING_TEST_DATABASE_URL ?? "postgres://scry:scry-local@localhost:54329/scry";

const testFile = "test/authoring.integration.test.ts";
const vitractFixtureFile = "scripts/fixtures/vitract-login-baseline.json";

const run = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", testFile, "--reporter=json", "--maxWorkers=1"],
  {
    cwd: new URL("../apps/api/", import.meta.url),
    encoding: "utf8",
    env: {
      ...process.env,
      SCRY_AUTHORING_TEST_DATABASE_URL: databaseUrl,
    },
  },
);

let report;

try {
  report = JSON.parse(run.stdout);
} catch {
  report = {
    testResults: [],
    parseError: true,
  };
}

let vitractBaseline;
let vitractFixtureError = null;

try {
  vitractBaseline = JSON.parse(
    readFileSync(
      new URL("../scripts/fixtures/vitract-login-baseline.json", import.meta.url),
      "utf8",
    ),
  );
} catch (error) {
  vitractFixtureError = error instanceof Error ? error.message : String(error);
  vitractBaseline = null;
}

const scenarios = (report.testResults ?? []).flatMap((suite) =>
  (suite.assertionResults ?? []).map((test) => ({
    suite: suite.name,
    scenario: test.title ?? test.fullName ?? "unknown",
    status: test.status,
    durationMs: test.duration ?? null,
    failureCode: test.failureMessages?.length ? "TEST_FAILURE" : null,
  })),
);

const corpus = [testFile, vitractFixtureFile];

const output = {
  schemaVersion: 2,
  implementation: process.env.SCRY_BASELINE_IMPLEMENTATION ?? "current",
  startedAt,
  durationMs: Math.round(performance.now() - started),
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    databaseConfigured: Boolean(databaseUrl),
  },
  corpus,
  corpusDigest: createHash("sha256")
    .update(
      [
        testFile,
        vitractFixtureFile,
        vitractBaseline ? JSON.stringify(vitractBaseline) : vitractFixtureError,
      ].join("\n"),
    )
    .digest("hex"),
  success: run.status === 0 && vitractBaseline !== null,
  exitCode: run.status,
  scenarios,
  summary: {
    passed: scenarios.filter((item) => item.status === "passed").length,
    failed: scenarios.filter((item) => item.status === "failed").length,
    skipped: scenarios.filter((item) => item.status === "skipped").length,
  },
  baselineAssertions: {
    cleanProbeProducesExecutionReady: scenarios.some(
      (item) =>
        item.status === "passed" &&
        item.scenario.includes(
          "edits without revisions, compiles once, and publishes one immutable revision",
        ),
    ),
    diagnosticProducesCalibrationRequired: scenarios.some(
      (item) =>
        item.status === "passed" &&
        item.scenario.includes(
          "keeps the draft in editing when a completed probe returns a diagnostic",
        ),
    ),
    vitractAuthenticationSucceeded:
      vitractBaseline?.observedOutcome?.authenticationSucceeded === true,
    vitractDashboardVerified: vitractBaseline?.observedOutcome?.dashboardVerified === true,
    vitractCurrentFlowFails: vitractBaseline?.observedOutcome?.flowSucceeded === false,
    vitractFailureIsProbeQualityRelated:
      vitractBaseline?.characterization?.probeQualityFailure === true,
    vitractFailureIsNotLoginRelated: vitractBaseline?.characterization?.loginFailure === false,
  },
  realWorldBaselines: vitractBaseline
    ? [
        {
          scenario: vitractBaseline.scenario,
          target: vitractBaseline.target,
          sourceRun: vitractBaseline.sourceRun,
          observedOutcome: vitractBaseline.observedOutcome,
          characterization: vitractBaseline.characterization,
          baselineExpectation: vitractBaseline.baselineExpectation,
        },
      ]
    : [],
  infrastructureOutput:
    run.status === 0 && vitractFixtureError === null
      ? undefined
      : {
          stderr: run.stderr.slice(-8_000),
          stdout: run.stdout.slice(-8_000),
          vitractFixtureError,
        },
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

process.stderr.write(
  `Authoring baseline: ${output.summary.passed} passed, ${output.summary.failed} failed, ${output.realWorldBaselines.length} real-world baseline, ${output.durationMs}ms total.\n`,
);

process.exit(output.success ? 0 : (run.status ?? 1));
