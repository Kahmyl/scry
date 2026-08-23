import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const plan = JSON.parse(readFileSync("artifacts/verification-affected-plan.json", "utf8"));
const results = [];

for (const workspace of plan.selected) {
  if (!workspace.scripts?.test) continue;
  if (["@scry/assurance", "@scry/praxis"].includes(workspace.name)) {
    results.push({
      workspace: workspace.name,
      status: "covered_by_browser_lane",
      passed: true,
    });
    continue;
  }

  const args = commandFor(workspace.name);
  const result = spawnSync("pnpm", args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  results.push({
    workspace: workspace.name,
    command: ["pnpm", ...args].join(" "),
    status: result.status,
    passed: result.status === 0,
  });
}

mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/verification-ci-unit-results.json",
  `${JSON.stringify({ schemaVersion: 1, plan, results }, null, 2)}\n`,
);

const failed = results.filter((result) => !result.passed);
process.stdout.write(
  `CI unit qualification: ${results.length - failed.length}/${results.length} selected workspace lanes passed.\n`,
);
process.exitCode = failed.length ? 1 : 0;

function commandFor(workspace) {
  if (workspace === "@scry/api")
    return [
      "--filter",
      workspace,
      "exec",
      "vitest",
      "run",
      "test/auth.service.test.ts",
      "test/confirmation-classification.test.ts",
      "test/credential.crypto.test.ts",
      "test/flow-contract-version-reader.test.ts",
      "test/mission-authoring-derivation.test.ts",
      "test/mission-completion-safety.test.ts",
      "test/mission-continuation-authority.test.ts",
      "test/mission-endpoints.test.ts",
      "test/mission-evidence-composition.test.ts",
      "test/mission-lifecycle-regression.test.ts",
      "test/mission-live-arguments.test.ts",
      "test/mission-recording-selection.test.ts",
      "test/orchestration.service.test.ts",
      "test/probe-compilation-classification.test.ts",
      "test/protected-input-capability.test.ts",
      "test/release-admission.service.test.ts",
      "test/report-commit-atomicity.test.ts",
      "test/report-commit-scoping.test.ts",
      "test/run-observation.service.test.ts",
      "test/successor-checkpoint-semantic.test.ts",
      "test/transcript-compiler.test.ts",
      "test/unknown-mutation-administration.service.test.ts",
      "test/unknown-operation-reconciliation.service.test.ts",
      "test/veil-policy-snapshot.test.ts",
      "test/worker-processors.test.ts",
      "--maxWorkers=4",
    ];

  if (workspace === "@scry/executor")
    return [
      "--filter",
      workspace,
      "exec",
      "vitest",
      "run",
      "test/artifacts.test.ts",
      "test/calibration-digest.test.ts",
      "test/execution-events.test.ts",
      "test/execution-report.test.ts",
      "test/execution-state.test.ts",
      "test/executor-ownership-closure.test.ts",
      "test/interaction-lifecycle.test.ts",
      "test/privacy-gauntlet.test.ts",
      "test/probe-step-selection.test.ts",
      "test/protected-response-envelope.test.ts",
      "test/protected-transaction-contract-ownership.test.ts",
      "test/protected-transaction-runtime-port.test.ts",
      "test/public-ownership-boundary.test.ts",
      "test/trace-coordinator-admission.test.ts",
      "test/trace-sanitizer.test.ts",
      "test/veil-policy-adapter.test.ts",
      "--maxWorkers=4",
    ];

  return ["--filter", workspace, "run", "test"];
}
