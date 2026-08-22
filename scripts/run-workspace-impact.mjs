import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { impactProfilesByIds } from "./verification-registry.mjs";

const root = process.cwd();

const [workspaceName, ...profileIds] = process.argv.slice(2);

if (!workspaceName) {
  throw new Error("run-workspace-impact requires a workspace");
}

if (profileIds.length === 0) {
  throw new Error("run-workspace-impact requires at least one profile id");
}

const profiles = impactProfilesByIds(workspaceName, profileIds);

const workspacePaths = [...new Set(profiles.map((profile) => profile.workspacePath))];

if (workspacePaths.length !== 1) {
  throw new Error(`Impact profiles disagree on workspace path for ${workspaceName}`);
}

const workspacePath = workspacePaths[0];

const tests = [...new Set(profiles.flatMap((profile) => profile.tests))].sort();

const missing = tests.filter(
  (testFile) => !fs.existsSync(path.join(root, workspacePath, testFile)),
);

if (missing.length > 0) {
  console.error("Impact registry is stale; refusing narrowed verification.");

  for (const file of missing) {
    console.error(`  missing: ${file}`);
  }

  console.error(`Run the full ${workspaceName} suite instead.`);

  process.exitCode = 2;
} else {
  console.log(`Workspace semantic profiles: ${profileIds.join(", ")}`);

  console.log(`Workspace: ${workspaceName}`);

  console.log(`Selected test files: ${tests.length}`);

  for (const profile of profiles) {
    console.log(`  ${profile.id}`);

    console.log(`    capabilities: ${profile.capabilities.join(", ")}`);
  }

  const result = spawnSync(
    "pnpm",
    ["--filter", workspaceName, "exec", "vitest", "run", ...tests, "--maxWorkers=1"],
    {
      cwd: root,
      env: {
        ...process.env,
        SCRY_BROWSER_CHANNEL: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      },
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
}
