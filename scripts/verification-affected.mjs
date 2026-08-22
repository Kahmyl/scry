import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import {
  STATIC_GATES,
  buildAffectedPlan,
  discoverWorkspaces,
} from "./verification-affected-lib.mjs";

import { verificationStrategyFor } from "./verification-registry.mjs";

const root = process.cwd();

const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

if (rootPackage.name !== "scry") {
  throw new Error(
    `verify:affected must run from Scry root; found "${rootPackage.name ?? "unknown"}"`,
  );
}

const options = parseArguments(process.argv.slice(2));

const base = options.base ?? defaultBase();

const files = options.files.length > 0 ? options.files : changedFiles(base);

const workspaces = discoverWorkspaces(root);

const plan = buildAffectedPlan({
  files,
  workspaces,
  full: options.full,
  resolveDependents,
});

const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  base,
  changedFiles: files,
  mode: plan.fullFallback ? "full-fallback" : "affected",
  ...plan,
  selected: plan.selected.map((workspace) => ({
    ...workspace,
    verification: verificationStrategyFor(workspace),
  })),
  staticGates: STATIC_GATES.filter((name) => Boolean(rootPackage.scripts?.[name])),
};

mkdirSync(path.join(root, "artifacts"), {
  recursive: true,
});

writeFileSync(
  path.join(root, "artifacts", "verification-affected-plan.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
);

printPlan(artifact, options.explain);

if (options.plan) {
  console.log();
  console.log("Plan only; no verification commands executed.");
  process.exitCode = 0;
} else {
  const results = executePlan(artifact);

  writeFileSync(
    path.join(root, "artifacts", "verification-affected-results.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        plan: artifact,
        results,
      },
      null,
      2,
    )}\n`,
  );

  const failed = results.filter((result) => !result.passed);

  console.log();
  console.log("== Affected verification summary ==");
  console.log(`Commands: ${results.length}`);
  console.log(`Passed: ${results.length - failed.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log();
    console.log("Failures:");

    for (const result of failed) {
      console.log(`  ${result.id}`);
    }

    process.exitCode = 1;
  }
}

function parseArguments(args) {
  const result = {
    full: false,
    plan: false,
    explain: false,
    base: null,
    files: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--") {
      continue;
    }

    if (argument === "--full") {
      result.full = true;
      continue;
    }

    if (argument === "--plan") {
      result.plan = true;
      continue;
    }

    if (argument === "--explain") {
      result.explain = true;
      continue;
    }

    if (argument === "--base") {
      const value = args[index + 1];

      if (!value) {
        throw new Error("--base requires a Git ref");
      }

      result.base = value;
      index += 1;
      continue;
    }

    if (argument === "--files") {
      const value = args[index + 1];

      if (!value) {
        throw new Error("--files requires a path or comma-separated paths");
      }

      result.files.push(
        ...value
          .split(",")
          .map((file) => file.trim())
          .filter(Boolean),
      );

      index += 1;
      continue;
    }

    throw new Error(`Unknown verify:affected option: ${argument}`);
  }

  return result;
}

function git(args, { optional = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    if (optional) {
      return null;
    }

    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }

  return result.stdout.trim();
}

function defaultBase() {
  if (
    git(["rev-parse", "--verify", "origin/main"], {
      optional: true,
    })
  ) {
    return "origin/main";
  }

  if (
    git(["rev-parse", "--verify", "HEAD^"], {
      optional: true,
    })
  ) {
    return "HEAD^";
  }

  return "HEAD";
}

function lines(value) {
  return value
    ? value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function changedFiles(baseRef) {
  const mergeBase = git(["merge-base", "HEAD", baseRef]);

  const result = new Set();

  for (const file of lines(git(["diff", "--name-only", `${mergeBase}...HEAD`]))) {
    result.add(file);
  }

  for (const file of lines(git(["diff", "--name-only"]))) {
    result.add(file);
  }

  for (const file of lines(git(["diff", "--cached", "--name-only"]))) {
    result.add(file);
  }

  for (const file of lines(git(["ls-files", "--others", "--exclude-standard"]))) {
    result.add(file);
  }

  return [...result].sort();
}

function resolveDependents(workspaceName) {
  const result = spawnSync(
    "pnpm",
    ["--filter", `...${workspaceName}`, "list", "--depth", "-1", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `pnpm dependency query failed with ${result.status}`);
  }

  let parsed;

  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("pnpm dependency query returned invalid JSON");
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];

  const names = rows.map((row) => row?.name).filter((name) => typeof name === "string");

  if (!names.includes(workspaceName)) {
    names.push(workspaceName);
  }

  return [...new Set(names)].sort();
}

function printPlan(plan, explain) {
  console.log("== Verification plan ==");
  console.log(`Base: ${plan.base}`);
  console.log(`Changed files: ${plan.changedFiles.length}`);
  console.log(`Mode: ${plan.mode}`);

  if (plan.fullFallbackReasons.length > 0) {
    console.log("Fallback reasons:");

    for (const reason of plan.fullFallbackReasons) {
      console.log(`  - ${reason}`);
    }
  }

  if (plan.directWorkspaces.length > 0) {
    console.log(`Direct workspaces: ${plan.directWorkspaces.join(", ")}`);
  }

  console.log(`Selected workspaces: ${plan.selected.length}`);

  for (const workspace of plan.selected) {
    console.log(`  - ${workspace.name}`);

    if (workspace.verification) {
      const strategy =
        workspace.verification.testMode === "focused"
          ? `focused (${workspace.verification.profileIds.join(", ")})`
          : `full (${workspace.verification.reason})`;

      console.log(`      Test strategy: ${strategy}`);
    }

    if (explain) {
      for (const reason of workspace.reasons) {
        console.log(`      ${reason}`);
      }

      if (workspace.verification?.capabilities?.length > 0) {
        console.log(`      Capabilities: ${workspace.verification.capabilities.join(", ")}`);
      }

      if (workspace.verification?.testMode === "focused") {
        console.log(`      Focused test files: ${workspace.verification.tests.length}`);
      }
    }
  }

  console.log(`Static gates: ${plan.staticGates.length}`);

  if (explain) {
    if (plan.changedFiles.length > 0) {
      console.log("Changed paths:");

      for (const file of plan.changedFiles) {
        console.log(`  - ${file}`);
      }
    }

    if (plan.ignoredFiles.length > 0) {
      console.log("Ignored documentation/generated paths:");

      for (const file of plan.ignoredFiles) {
        console.log(`  - ${file}`);
      }
    }
  }
}

function executePlan(plan) {
  const results = [];

  for (const gate of plan.staticGates) {
    results.push(
      runCommand({
        id: `root:${gate}`,
        command: "pnpm",
        args: ["run", gate],
      }),
    );
  }

  for (const workspace of plan.selected) {
    if (workspace.scripts.typecheck) {
      results.push(
        runCommand({
          id: `${workspace.name}:typecheck`,
          command: "pnpm",
          args: ["--filter", workspace.name, "run", "typecheck"],
        }),
      );
    }

    if (workspace.scripts.test) {
      results.push(runWorkspaceTest(workspace));
    }
  }

  return results;
}

function runWorkspaceTest(workspace) {
  if (workspace.verification?.testMode === "focused") {
    console.log();
    console.log(`IMPACT_PROFILE: ${workspace.verification.profileIds.join(", ")}`);
    console.log(`IMPACT_CAPABILITIES: ${workspace.verification.capabilities.join(", ")}`);
    console.log(`IMPACT_TEST_FILES: ${workspace.verification.tests.length}`);

    return runCommand({
      id: `${workspace.name}:test:focused-impact`,
      command: "node",
      args: [
        "scripts/run-workspace-impact.mjs",
        workspace.name,
        ...workspace.verification.profileIds,
      ],
      note: "Reviewed downstream semantic impact. Direct or uncertain changes still run the full workspace suite.",
    });
  }

  const historicalSnapshot = "/private/tmp/scry-m1-cutover-2b9e22e42cf3/development-db.dump";

  if (workspace.name === "@scry/api" && !existsSync(historicalSnapshot)) {
    console.log();
    console.log(
      "BETA_QUALIFICATION_GAP: M1_SNAPSHOT_REQUIRED; excluding only the immutable historical snapshot qualification.",
    );

    return runCommand({
      id: "@scry/api:test",
      command: "pnpm",
      args: [
        "--filter",
        "@scry/api",
        "exec",
        "vitest",
        "run",
        "--exclude",
        "test/m1-snapshot-migration.qualification.test.ts",
      ],
      note: "M1 historical snapshot unavailable; mirrors current test:beta qualification behavior.",
    });
  }

  return runCommand({
    id: `${workspace.name}:test`,
    command: "pnpm",
    args: ["--filter", workspace.name, "run", "test"],
  });
}

function runCommand({ id, command, args, note = null }) {
  console.log();
  console.log(`== ${id} ==`);

  const startedAt = performance.now();

  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;

  const record = {
    id,
    command: [command, ...args].join(" "),
    durationMs,
    status: result.status,
    signal: result.signal ?? null,
    passed: result.status === 0,
    note,
  };

  console.log(`${record.passed ? "PASS" : "FAIL"} ${id} (${(durationMs / 1000).toFixed(2)}s)`);

  return record;
}
