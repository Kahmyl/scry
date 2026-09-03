import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  createDeterministicEngineeringAgentAdapter,
  runEngineeringLabExperiment,
} from "../src/index.js";

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const artifactRootArgument = process.argv[2];

if (!artifactRootArgument) {
  throw new Error("Usage: engineering-lab-seeded <new-artifact-directory>");
}

const fixturePath = "packages/assurance/test/fixtures/engineering-lab-seeded-defect/counter.mjs";
const failedPatch = `diff --git a/${fixturePath} b/${fixturePath}
--- a/${fixturePath}
+++ b/${fixturePath}
@@ -1,3 +1,3 @@
 export function increment(value) {
-  return value - 1;
+  return value + 2;
 }
`;
const repairPatch = `diff --git a/${fixturePath} b/${fixturePath}
--- a/${fixturePath}
+++ b/${fixturePath}
@@ -1,3 +1,3 @@
 export function increment(value) {
-  return value - 1;
+  return value + 1;
 }
`;
const adapter = createDeterministicEngineeringAgentAdapter({
  id: "assurance-seeded-repair",
  attempts: [
    {
      id: "off-by-two",
      hypothesis:
        "Changing the decrement to an increment is sufficient, but this first magnitude is wrong.",
      patch: failedPatch,
    },
    {
      id: "minimal-off-by-one-repair",
      hypothesis: "The implementation violates the exact increment invariant by using subtraction.",
      patch: repairPatch,
    },
  ],
});
const result = await runEngineeringLabExperiment({
  experimentId: "item-09-seeded-increment",
  issueId: "post-beta-item-09-seeded-defect",
  sourceRoot,
  artifactRoot: path.resolve(artifactRootArgument),
  invariants: [
    "Assurance is downstream and never synchronous runtime admission authority.",
    "Candidate patches remain isolated artifacts and require human authorization.",
    "Unknown mutation truth remains unknown; this experiment performs no provider mutation.",
  ],
  verification: {
    id: "seeded-increment-regression",
    claim: "increment(value) returns value + 1",
    command: {
      executable: process.execPath,
      args: ["--test", "counter.test.mjs"],
      relativeCwd: "packages/assurance/test/fixtures/engineering-lab-seeded-defect",
      timeoutMs: 30_000,
    },
    reproductionExpectedExitCode: 1,
    candidateExpectedExitCode: 0,
  },
  runtime: {
    database: "isolated_local_directory",
    queue: "isolated_local_namespace",
    browser: "isolated_local_profile",
    fixtures: [fixturePath],
    portCount: 3,
  },
  untrackedPolicy: {
    allowedPathPrefixes: ["packages/assurance/test/fixtures/engineering-lab-seeded-defect"],
    maxFileBytes: 64 * 1024,
    maxTotalBytes: 128 * 1024,
  },
  approvedAdapter: adapter.descriptor,
  adapter,
  adapterCohorts: [
    {
      cohort: "deterministic-fake",
      status: "available",
    },
    {
      cohort: "installed-codex-cli",
      status: "unavailable",
      reason:
        "Inspected CLI help did not prove a configuration that preserves model transport while mechanically forcing all spawned agent commands to local-only network-disabled execution.",
      inspectedCapabilities: [
        "exec --ephemeral",
        "exec --ignore-user-config",
        "exec -s workspace-write",
        "exec -a never",
        "sandbox --sandbox-state-disable-network (requires a separate sandbox state/profile)",
      ],
    },
  ],
  networkPolicy: "disabled",
  externalSystemPolicy: "none",
});

process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
